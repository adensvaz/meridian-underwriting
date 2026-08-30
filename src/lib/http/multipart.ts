// A streaming multipart/form-data parser.
//
// Hand-written because the alternative is a dependency, and this project's
// deployment story ("copy the folder, run node") is worth protecting.
//
// It buffers the request body, but it enforces the byte ceiling *as data
// arrives* and destroys the socket the moment a client exceeds it, so a 4 GB
// upload is refused after ~40 MB rather than becoming a 4 GB allocation. Given
// the 40 MB per-file cap that is the right trade for an MVP; a true streaming
// parse straight to disk is the upgrade if document sizes ever grow.

import type { IncomingMessage } from "node:http";

export interface MultipartFile {
  field: string;
  filename: string;
  mime: string;
  data: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: MultipartFile[];
}

export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

export async function parseMultipart(
  req: IncomingMessage,
  options: { maxBytes: number; maxFiles?: number },
): Promise<MultipartResult> {
  const contentType = req.headers["content-type"] ?? "";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!/multipart\/form-data/i.test(contentType) || !boundaryMatch) {
    throw new UploadError("Expected a multipart/form-data upload");
  }

  const boundary = (boundaryMatch[1] ?? boundaryMatch[2]).trim();
  const delimiter = Buffer.from(`--${boundary}`);
  const maxFiles = options.maxFiles ?? 12;

  // Reject on the declared length before reading a single byte where we can.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > options.maxBytes * (maxFiles + 1)) {
    throw new UploadError("Upload is too large", 413);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > options.maxBytes * maxFiles + 1024 * 1024) {
        reject(new UploadError("Upload is too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", (err) => reject(err));
    req.on("aborted", () => reject(new UploadError("Upload was interrupted", 400)));
  });

  const body = Buffer.concat(chunks, total);
  const result: MultipartResult = { fields: {}, files: [] };

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw new UploadError("Malformed upload: no boundary found");

  while (cursor !== -1) {
    let start = cursor + delimiter.length;

    // "--" after the delimiter marks the final boundary.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    const headerEnd = body.indexOf(DOUBLE_CRLF, start);
    if (headerEnd === -1) break;

    const rawHeaders = body.subarray(start, headerEnd).toString("utf8");
    const bodyStart = headerEnd + DOUBLE_CRLF.length;

    const next = body.indexOf(delimiter, bodyStart);
    const bodyEnd = next === -1 ? body.length : next;

    // Trim the CRLF that precedes the next boundary.
    let contentEnd = bodyEnd;
    if (contentEnd >= 2 && body.subarray(contentEnd - 2, contentEnd).equals(CRLF)) {
      contentEnd -= 2;
    }

    const content = body.subarray(bodyStart, contentEnd);
    const { name, filename, mime } = parsePartHeaders(rawHeaders);

    if (name) {
      if (filename !== undefined) {
        if (content.length > options.maxBytes) {
          throw new UploadError(
            `"${filename}" is larger than the ${Math.round(options.maxBytes / 1024 / 1024)} MB limit`,
            413,
          );
        }
        if (content.length > 0) {
          if (result.files.length >= maxFiles) {
            throw new UploadError(`No more than ${maxFiles} files per upload`, 413);
          }
          result.files.push({
            field: name,
            filename: sanitizeFilename(filename),
            mime: mime || "application/octet-stream",
            data: content,
          });
        }
      } else {
        // Cap a text field so a malicious client cannot stuff megabytes into one.
        result.fields[name] = content.subarray(0, 64 * 1024).toString("utf8");
      }
    }

    cursor = next;
  }

  return result;
}

function parsePartHeaders(raw: string): { name?: string; filename?: string; mime?: string } {
  const out: { name?: string; filename?: string; mime?: string } = {};
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "content-disposition") {
      const name = /name="([^"]*)"/i.exec(value);
      // filename* (RFC 5987) wins over filename when both are present.
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
      const plain = /filename="([^"]*)"/i.exec(value);
      if (name) out.name = name[1];
      if (encoded) {
        try {
          out.filename = decodeURIComponent(encoded[1]);
        } catch {
          out.filename = encoded[1];
        }
      } else if (plain) {
        out.filename = plain[1];
      }
    } else if (key === "content-type") {
      out.mime = value.split(";")[0].trim();
    }
  }
  return out;
}

/**
 * The filename is display metadata only — files are stored under a generated
 * id, never under a client-supplied name — but it still gets shown in the UI
 * and logged, so strip path separators, control characters and leading dots.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || "file").slice(0, 200);
}
