// Per-page PDF text extraction.
//
// Two things here are not negotiable.
//
// 1. TEXT MUST COME OUT PER PAGE. The page number is the provenance unit shown
//    in the review UI ("NOI 4,120,000 — OM p.14"). pdf-parse hands back one
//    concatenated blob by default, so we install a `pagerender` callback and
//    keep each page's text separately. If that somehow fails we fall back to
//    splitting the blob and say so in `meta.extraction`, because a wrong page
//    number is worse than an honest "we could not tell".
//
// 2. SCANNED PDFs MUST BE CALLED SCANNED. An image-only OM yields ~0 characters.
//    Left unflagged it flows into the AI extraction pass as an empty document
//    and comes back as a set of confidently invented numbers. Below ~50 useful
//    characters per page we set `isScanned` and the upload pipeline shows
//    "this document is scanned and cannot be read as text".
//
// A NOTE ON THE BUFFER CONVERSION BELOW — it is not defensive noise. pdf-parse
// forwards whatever you give it to pdf.js, whose worker shim re-wraps a typed
// array as `new value.constructor(value.buffer)`. A Node Buffer is a view into
// a shared 64 KB allocation pool, so that re-wrap yields a view over the WHOLE
// pool starting at offset 0 — i.e. pdf.js parses unrelated memory and throws
// "bad XRef entry" on perfectly valid PDFs. Copying into a standalone
// Uint8Array whose ArrayBuffer it exactly owns is what makes this work at all.

import pdfParse from "pdf-parse";

export interface PdfPage {
  /** 1-based, matching what the viewer shows. */
  pageNo: number;
  text: string;
}

export interface PdfMeta {
  info: Record<string, unknown> | null;
  pdfVersion: string | null;
  /** "pagerender" | "formfeed" | "blob-split" | "blob" | "none" */
  extraction: string;
  /** Average non-whitespace characters per page. Drives `isScanned`. */
  charsPerPage: number;
  truncated: boolean;
  warnings: string[];
}

export interface PdfParseResult {
  ok: boolean;
  pages: PdfPage[];
  pageCount: number;
  hasTextLayer: boolean;
  isScanned: boolean;
  meta: PdfMeta;
  error?: string;
}

export interface PdfParseOptions {
  /** Stop collecting text past this many characters. Default 2 MB. */
  maxChars?: number;
  /** Hard page ceiling; 0 means "all pages". */
  maxPages?: number;
}

/** Below this many non-whitespace chars per page we call it image-only. */
export const SCANNED_CHARS_PER_PAGE = 50;

const DEFAULT_MAX_CHARS = 2 * 1024 * 1024;

/**
 * Copy into a Uint8Array that exclusively owns its ArrayBuffer.
 * See the header comment — this is the difference between working and not.
 */
function toStandaloneBytes(input: Buffer | Uint8Array): Uint8Array {
  const view = input instanceof Uint8Array ? input : Buffer.from(input as never);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

function usefulChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function tidy(text: string): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract text from a PDF, one entry per page.
 *
 * Never throws. A corrupt, encrypted or truncated file comes back as
 * `ok: false` with a human-readable `error`.
 */
export async function parsePdf(
  buffer: Buffer | Uint8Array,
  options?: PdfParseOptions,
): Promise<PdfParseResult> {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const warnings: string[] = [];

  const fail = (message: string): PdfParseResult => ({
    ok: false,
    pages: [],
    pageCount: 0,
    hasTextLayer: false,
    isScanned: false,
    meta: {
      info: null,
      pdfVersion: null,
      extraction: "none",
      charsPerPage: 0,
      truncated: false,
      warnings,
    },
    error: message,
  });

  try {
    if (!buffer || buffer.byteLength === 0) return fail("PDF is empty (0 bytes)");

    const bytes = toStandaloneBytes(buffer);
    if (Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF", 0, "latin1") === -1) {
      warnings.push("no %PDF header in the first 1 KB; attempting to parse anyway");
    }

    const collected = new Map<number, string>();
    let fallbackCounter = 0;
    let charBudget = maxChars;
    let truncated = false;

    const pagerender = (pageData: {
      pageNumber?: number;
      pageIndex?: number;
      getTextContent: (opts?: unknown) => Promise<{ items: Array<{ str: string; transform: number[] }> }>;
    }): Promise<string> => {
      const pageNo =
        typeof pageData?.pageNumber === "number"
          ? pageData.pageNumber
          : typeof pageData?.pageIndex === "number"
            ? pageData.pageIndex + 1
            : ++fallbackCounter;

      if (charBudget <= 0) {
        truncated = true;
        collected.set(pageNo, "");
        return Promise.resolve("");
      }

      return pageData
        .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        .then((content) => {
          // Rebuild lines from the text items' vertical position. pdf.js emits
          // one item per run; without this every page collapses to one line and
          // any table in the OM becomes unreadable.
          let lastY: number | undefined;
          let text = "";
          for (const item of content?.items ?? []) {
            const y = item?.transform?.[5];
            if (lastY === undefined || lastY === y) text += item?.str ?? "";
            else text += "\n" + (item?.str ?? "");
            lastY = y;
          }
          let value = tidy(text);
          if (value.length > charBudget) {
            value = value.slice(0, Math.max(charBudget, 0));
            truncated = true;
          }
          charBudget -= value.length;
          collected.set(pageNo, value);
          return value;
        })
        .catch(() => {
          collected.set(pageNo, "");
          warnings.push(`page ${pageNo}: text layer could not be read`);
          return "";
        });
    };

    let result: {
      numpages?: number;
      numrender?: number;
      text?: string;
      info?: Record<string, unknown> | null;
      version?: string;
    };
    try {
      result = await pdfParse(bytes as never, {
        pagerender: pagerender as never,
        max: options?.maxPages ?? 0,
      } as never);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (/password|encrypt/i.test(message)) {
        return fail(`PDF is password protected and cannot be read (${message})`);
      }
      return fail(`PDF could not be parsed: ${message}`);
    }

    const pageCount = Number.isFinite(result?.numpages) ? Number(result.numpages) : collected.size;
    let pages: PdfPage[] = [];
    let extraction = "pagerender";

    if (collected.size > 0) {
      pages = [...collected.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pageNo, text]) => ({ pageNo, text }));
      if (pageCount > 0 && pages.length !== pageCount) {
        warnings.push(
          `per-page extraction produced ${pages.length} page(s) for a ${pageCount}-page document`,
        );
      }
    } else {
      // pagerender never fired. Recover page boundaries from the blob.
      const blob = tidy(result?.text ?? "");
      if (blob.includes("\f")) {
        extraction = "formfeed";
        warnings.push(
          "per-page extraction failed; page boundaries recovered by splitting on form-feed (\\f) " +
            "— page numbers are approximate",
        );
        pages = blob.split("\f").map((text, i) => ({ pageNo: i + 1, text: tidy(text) }));
      } else if (pageCount > 1 && blob.includes("\n\n")) {
        extraction = "blob-split";
        warnings.push(
          "per-page extraction failed and no form-feed markers were present; the whole document " +
            "is reported as one segment and page numbers are not reliable",
        );
        pages = [{ pageNo: 1, text: blob }];
      } else {
        extraction = "blob";
        pages = blob === "" ? [] : [{ pageNo: 1, text: blob }];
      }
      const total = pages.reduce((n, p) => n + p.text.length, 0);
      if (total > maxChars) {
        truncated = true;
        let budget = maxChars;
        pages = pages.map((p) => {
          const text = p.text.slice(0, Math.max(budget, 0));
          budget -= text.length;
          return { pageNo: p.pageNo, text };
        });
      }
    }

    const totalUseful = pages.reduce((n, p) => n + usefulChars(p.text), 0);
    const effectivePages = Math.max(pageCount || pages.length, 1);
    const charsPerPage = totalUseful / effectivePages;
    const hasTextLayer = totalUseful > 0;
    const isScanned = !truncated && charsPerPage < SCANNED_CHARS_PER_PAGE;

    if (isScanned) {
      warnings.push(
        `only ${Math.round(charsPerPage)} readable characters per page — this document appears to ` +
          "be scanned or image-only and cannot be read as text",
      );
    }
    if (truncated) {
      warnings.push(`extracted text truncated at ${maxChars} characters`);
    }

    return {
      ok: true,
      pages,
      pageCount: pageCount || pages.length,
      hasTextLayer,
      isScanned,
      meta: {
        info: (result?.info as Record<string, unknown>) ?? null,
        pdfVersion: result?.version ?? null,
        extraction,
        charsPerPage: Math.round(charsPerPage * 10) / 10,
        truncated,
        warnings,
      },
    };
  } catch (err) {
    return fail(`PDF could not be parsed: ${(err as Error)?.message ?? String(err)}`);
  }
}
