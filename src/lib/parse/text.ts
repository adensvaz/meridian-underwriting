// Plain text, HTML and markdown.
//
// The HTML path matters more than it looks. When a broker portal serves a login
// or 404 page under a `.pdf` name, detect.ts catches it and it lands here — and
// the extracted text ("Sign in to continue") is what lets the upload pipeline
// tell the user their file is not the document they think it is. So HTML is
// stripped to readable text with block structure preserved as newlines, not
// squashed into one line.

import type { FileType } from "./detect.ts";

export interface TextSection {
  ordinal: number;
  heading: string | null;
  level: number;
  content: string;
}

export interface TextParseResult {
  ok: boolean;
  text: string;
  sections: TextSection[];
  /** Tables recovered from HTML markup, if any. */
  tables: string[][][];
  warnings: string[];
  error?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  dagger: "†",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  ntilde: "ñ",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
};

/** Decode named and numeric HTML entities. Unknown entities are left intact. */
export function decodeEntities(input: string): string {
  return String(input ?? "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|body|caption|div|dd|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|tfoot|thead|tr|ul";

/** Strip markup, decode entities, and keep block structure as line breaks. */
export function htmlToText(html: string): string {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<\/?(br|wbr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(td|th)\b[^>]*>/gi, "\t");
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/ /g, " ").replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, (m) => (m.includes("\t") ? "\t" : " ")).trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function attrValue(tag: string, name: string): number {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"?'?(\\d+)`, "i"));
  const n = m ? Number.parseInt(m[1]!, 10) : 1;
  return Number.isFinite(n) && n > 0 && n < 200 ? n : 1;
}

/**
 * Pull `<table>` elements out as rows of cell text.
 *
 * `colspan` is expanded by repeating the value into every covered cell, which
 * matches how sheet.ts unmerges Excel merges — a merged header must land on
 * every column it spans or the header inference downstream sees holes.
 */
export function extractHtmlTables(html: string): string[][][] {
  const source = String(html ?? "");
  const tables: string[][][] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(source)) !== null) {
    const body = tableMatch[1] ?? "";
    const rows: string[][] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(body)) !== null) {
      const cells: string[] = [];
      const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[1] ?? "")) !== null) {
        const value = htmlToText(cellMatch[3] ?? "").replace(/[\n\t]+/g, " ").trim();
        const span = attrValue(cellMatch[2] ?? "", "colspan");
        for (let i = 0; i < span; i++) cells.push(value);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

const MAX_SECTION_CHARS = 8000;

function pushSection(
  sections: TextSection[],
  heading: string | null,
  level: number,
  content: string,
): void {
  const trimmed = content.trim();
  if (trimmed === "" && heading === null) return;
  sections.push({ ordinal: sections.length, heading, level, content: trimmed });
}

/** Split markdown on ATX headings, keeping each heading with its body. */
function sectionsFromMarkdown(text: string): TextSection[] {
  const lines = text.split("\n");
  const sections: TextSection[] = [];
  let heading: string | null = null;
  let level = 0;
  let buffer: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (heading !== null || buffer.join("").trim() !== "") {
        pushSection(sections, heading, level, buffer.join("\n"));
      }
      heading = m[2]!.trim();
      level = m[1]!.length;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (heading !== null || buffer.join("").trim() !== "") {
    pushSection(sections, heading, level, buffer.join("\n"));
  }
  return sections.length > 0 ? sections : sectionsFromPlain(text);
}

/** Split HTML on h1..h6 so a converted DOCX keeps its outline. */
export function sectionsFromHtml(html: string): TextSection[] {
  const source = String(html ?? "");
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  const marks: Array<{ start: number; end: number; level: number; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(source)) !== null) {
    marks.push({
      start: m.index,
      end: m.index + m[0].length,
      level: Number.parseInt(m[1]!, 10),
      title: htmlToText(m[2] ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  if (marks.length === 0) return sectionsFromPlain(htmlToText(source));

  const sections: TextSection[] = [];
  const preamble = htmlToText(source.slice(0, marks[0]!.start));
  if (preamble.trim() !== "") pushSection(sections, null, 0, preamble);
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const bodyEnd = i + 1 < marks.length ? marks[i + 1]!.start : source.length;
    pushSection(sections, mark.title, mark.level, htmlToText(source.slice(mark.end, bodyEnd)));
  }
  return sections;
}

/**
 * No headings available: split on form feeds (a real page break in text dumps),
 * then group paragraphs so no segment gets absurdly large.
 */
export function sectionsFromPlain(text: string): TextSection[] {
  const body = String(text ?? "");
  const sections: TextSection[] = [];

  const chunks = body.includes("\f") ? body.split("\f") : [body];
  for (const chunk of chunks) {
    const paragraphs = chunk.split(/\n{2,}/);
    let buffer: string[] = [];
    let size = 0;
    for (const paragraph of paragraphs) {
      if (size > 0 && size + paragraph.length > MAX_SECTION_CHARS) {
        pushSection(sections, null, 0, buffer.join("\n\n"));
        buffer = [];
        size = 0;
      }
      buffer.push(paragraph);
      size += paragraph.length + 2;
    }
    if (buffer.join("").trim() !== "") pushSection(sections, null, 0, buffer.join("\n\n"));
  }

  if (sections.length === 0 && body.trim() !== "") pushSection(sections, null, 0, body);
  return sections;
}

/**
 * Decode a text-ish buffer and segment it. Never throws: an undecodable buffer
 * comes back as `ok: false` with an explanation.
 */
export async function parseTextDocument(
  buffer: Buffer | Uint8Array,
  type: FileType,
): Promise<TextParseResult> {
  const warnings: string[] = [];
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (buf.length === 0) {
      return { ok: true, text: "", sections: [], tables: [], warnings: ["file is empty (0 bytes)"] };
    }

    let raw = buf.toString("utf8");
    // U+FFFD in quantity means the bytes were not UTF-8; latin1 at least keeps
    // the ASCII skeleton readable rather than filling the text with replacement
    // characters that the AI layer would treat as content.
    const replacements = (raw.match(/�/g) ?? []).length;
    if (replacements > 0 && replacements / Math.max(raw.length, 1) > 0.01) {
      raw = buf.toString("latin1");
      warnings.push("file is not valid UTF-8; decoded as latin-1, some characters may be wrong");
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    raw = raw.replace(/\r\n?/g, "\n");

    if (type === "html") {
      const text = htmlToText(raw);
      const tables = extractHtmlTables(raw);
      const sections = sectionsFromHtml(raw);
      if (text.trim().length < 200 && /sign in|log ?in|not found|403|404|access denied/i.test(text)) {
        warnings.push(
          "this looks like a web page (login/error), not a document — check the source of the upload",
        );
      }
      return { ok: true, text, sections, tables, warnings };
    }

    if (type === "markdown") {
      return { ok: true, text: raw.trim(), sections: sectionsFromMarkdown(raw), tables: [], warnings };
    }

    return { ok: true, text: raw.trim(), sections: sectionsFromPlain(raw), tables: [], warnings };
  } catch (err) {
    return {
      ok: false,
      text: "",
      sections: [],
      tables: [],
      warnings,
      error: `could not decode text document: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}
