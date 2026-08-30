// The ingestion pipeline: bytes on disk → parsed segments → extracted inputs.
//
// Stages, and what each one guarantees:
//
//   store    the file is written under a generated id outside the web root,
//            hashed, and never served from a static path
//   parse    magic-byte type detection, per-page / per-sheet segmentation
//   classify what kind of document this actually is, regardless of its label
//   extract  AI structured extraction, or deterministic table parsing when no
//            key is configured
//   persist  fields, rent-roll rows and T12 lines, each with provenance
//
// Nothing here throws on a bad document. A file that cannot be read is recorded
// as failed with a readable reason and the rest of the deal continues, because
// one unreadable scan must not block underwriting on the other two documents.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.ts";
import { parseDocument } from "./parse/index.ts";
import { extractFromDocument, PROMPT_VERSION, type ExtractionPayload } from "./ai/extract.ts";
import { categoriseLabel, nonRecurringReason, ruleBasedExtraction } from "./ai/fallback.ts";
import { aiAvailable } from "./ai/client.ts";
import type { ModelDefinition } from "./engine/types.ts";
import type { AuthenticatedUser } from "./auth/session.ts";
import {
  createDocument,
  createExtraction,
  getDeal,
  getModelDefinition,
  getSegments,
  id,
  listDocuments,
  replaceRentRoll,
  replaceT12,
  saveSegments,
  touchDeal,
  updateDocument,
  upsertAiField,
  type DocumentRow,
} from "./db/repo.ts";

type ExtractionOutcomeShape = {
  ok: boolean;
  engine: "ai" | "rules";
  payload?: ExtractionPayload;
  error?: string;
  durationMs: number;
  tokensIn?: number;
  tokensOut?: number;
};

export interface StoredUpload {
  document: DocumentRow;
  warnings: string[];
}

/**
 * Writes the bytes and parses them. Files live under data/uploads/<dealId>/ with
 * a generated filename; the client-supplied name is display metadata only and
 * never touches the filesystem path.
 */
export async function storeAndParse(
  actor: AuthenticatedUser,
  dealId: string,
  file: { filename: string; mime: string; data: Buffer },
  declaredKind: string,
): Promise<StoredUpload | { error: string }> {
  const deal = getDeal(actor, dealId);
  if (!deal) return { error: "Deal not found" };

  const parsed = await parseDocument(file.data, file.filename, declaredKind);

  const sha256 = createHash("sha256").update(file.data).digest("hex");
  const dir = join(env.uploadDir, dealId);
  mkdirSync(dir, { recursive: true });

  const storageName = `${id()}${extensionFor(parsed.type)}`;
  const storagePath = join(dir, storageName);
  writeFileSync(storagePath, file.data, { mode: 0o600 });

  const kind = declaredKind && declaredKind !== "auto" ? declaredKind : parsed.guessedKind;

  const document = createDocument(actor, dealId, {
    kind,
    kind_source: declaredKind && declaredKind !== "auto" ? "user" : "detected",
    filename: file.filename,
    mime: parsed.mime || file.mime,
    detected_type: parsed.type,
    bytes: file.data.length,
    sha256,
    storage_path: storagePath,
    page_count: parsed.pageCount ?? null,
    sheet_count: parsed.sheetCount ?? null,
    has_text_layer: parsed.hasTextLayer === undefined ? null : parsed.hasTextLayer ? 1 : 0,
    is_scanned: parsed.isScanned ? 1 : 0,
    status: parsed.ok ? "parsed" : "failed",
    error: parsed.error ?? null,
  });

  if (!document) return { error: "Could not record the document" };

  if (parsed.ok && parsed.segments.length) {
    saveSegments(
      dealId,
      document.id,
      parsed.segments.map((s) => ({
        ordinal: s.ordinal,
        pageNo: s.pageNo ?? null,
        sheetName: s.sheetName ?? null,
        content: s.content,
      })),
    );
  }

  touchDeal(dealId);

  const warnings = [...(parsed.warnings ?? [])];
  if (parsed.isScanned) {
    warnings.push(
      `"${file.filename}" appears to be a scan or photograph with no text layer. Its figures cannot be read automatically — enter them manually on the review screen.`,
    );
  }

  return { document, warnings };
}

function extensionFor(type: string): string {
  const map: Record<string, string> = {
    pdf: ".pdf",
    xlsx: ".xlsx",
    xls: ".xls",
    docx: ".docx",
    doc: ".doc",
    csv: ".csv",
    tsv: ".tsv",
    html: ".html",
    text: ".txt",
  };
  return map[type] ?? ".bin";
}

export function removeStoredFile(doc: DocumentRow): void {
  try {
    if (doc.storage_path && existsSync(doc.storage_path)) unlinkSync(doc.storage_path);
  } catch (err) {
    // A file we cannot delete is worth logging but must not fail the request;
    // the database row is gone and the file is unreachable either way.
    console.error(`[pipeline] could not unlink ${doc.storage_path}`, err);
  }
}

// ------------------------------------------------------------- extraction ---

export interface ExtractionSummary {
  documentId: string;
  filename: string;
  kind: string;
  ok: boolean;
  engine: "ai" | "rules";
  fieldCount: number;
  unitCount: number;
  t12Count: number;
  notes: string[];
  error?: string;
  durationMs: number;
}

export interface ExtractionRunResult {
  summaries: ExtractionSummary[];
  fieldsWritten: number;
  aiUsed: boolean;
}

export async function runExtraction(
  actor: AuthenticatedUser,
  dealId: string,
): Promise<ExtractionRunResult> {
  const deal = getDeal(actor, dealId);
  if (!deal) throw new Error("Deal not found");
  if (!deal.model_id) throw new Error("Select an underwriting model before extracting");

  const definition = getModelDefinition(actor, deal.model_id);
  if (!definition) throw new Error("Underwriting model not found");

  const documents = listDocuments(actor, dealId).slice(0, env.maxDocsPerDeal);
  const summaries: ExtractionSummary[] = [];
  let fieldsWritten = 0;
  let aiUsed = false;

  touchDeal(dealId, "extracting");

  for (const doc of documents) {
    const segments = getSegments(actor, doc.id).map((s) => ({
      pageNo: s.page_no,
      sheetName: s.sheet_name,
      content: s.content,
    }));

    if (doc.status === "failed" || !segments.length) {
      summaries.push({
        documentId: doc.id,
        filename: doc.filename,
        kind: doc.kind,
        ok: false,
        engine: "rules",
        fieldCount: 0,
        unitCount: 0,
        t12Count: 0,
        notes: [],
        error: doc.error ?? "No readable content was extracted from this file",
        durationMs: 0,
      });
      continue;
    }

    let outcome: Awaited<ReturnType<typeof extractFromDocument>>;

    if (aiAvailable()) {
      outcome = await extractFromDocument(
        {
          id: doc.id,
          filename: doc.filename,
          kind: doc.kind,
          isScanned: doc.is_scanned === 1,
          segments,
        },
        definition,
      );
    } else {
      // No API key. Re-parse from disk rather than working off the stored text,
      // because the deterministic extractor needs the classified TABLES and
      // only the segments were persisted. Parsing is local and fast.
      outcome = await ruleBasedOutcome(doc, definition);
    }

    if (outcome.engine === "ai" && outcome.ok) aiUsed = true;

    createExtraction(dealId, actor.id, {
      documentId: doc.id,
      kind: doc.kind,
      engine: outcome.engine,
      model: outcome.engine === "ai" ? env.model : null,
      promptVersion: PROMPT_VERSION,
      status: outcome.ok ? "ok" : "failed",
      raw: outcome.payload,
      error: outcome.error ?? null,
      tokensIn: outcome.tokensIn ?? null,
      tokensOut: outcome.tokensOut ?? null,
      durationMs: outcome.durationMs,
    });

    if (!outcome.ok || !outcome.payload) {
      summaries.push({
        documentId: doc.id,
        filename: doc.filename,
        kind: doc.kind,
        ok: false,
        engine: outcome.engine,
        fieldCount: 0,
        unitCount: 0,
        t12Count: 0,
        notes: [],
        error: outcome.error,
        durationMs: outcome.durationMs,
      });
      continue;
    }

    const written = persistPayload(dealId, actor.id, doc, outcome.payload);
    fieldsWritten += written.fields;

    // If the model disagrees with the user's label, record what it actually is
    // but do not overwrite an explicit user choice.
    if (doc.kind_source === "detected" && outcome.payload.document_kind !== doc.kind) {
      updateDocument(doc.id, { kind: outcome.payload.document_kind });
    }

    summaries.push({
      documentId: doc.id,
      filename: doc.filename,
      kind: doc.kind,
      ok: true,
      engine: outcome.engine,
      fieldCount: written.fields,
      unitCount: written.units,
      t12Count: written.t12,
      notes: outcome.payload.notes ?? [],
      durationMs: outcome.durationMs,
    });
  }

  touchDeal(dealId, "review");

  return { summaries, fieldsWritten, aiUsed };
}

function persistPayload(
  dealId: string,
  ownerId: string,
  doc: DocumentRow,
  payload: ExtractionPayload,
): { fields: number; units: number; t12: number } {
  let fields = 0;

  for (const field of payload.fields ?? []) {
    upsertAiField(dealId, ownerId, {
      key: field.key,
      value: field.value,
      confidence: field.confidence,
      documentId: doc.id,
      page: field.page,
      sheet: field.sheet,
      snippet: field.snippet,
    });
    fields++;
  }

  const units = payload.units ?? [];
  if (units.length) {
    replaceRentRoll(
      dealId,
      ownerId,
      units.map((u, index) => ({
        ordinal: index + 1,
        unit_no: u.unit_no,
        unit_type: u.unit_type,
        beds: u.beds,
        area_sqft: u.area_sqft,
        in_place_rent: u.in_place_rent,
        market_rent: u.market_rent,
        cheques: u.cheques,
        lease_start: u.lease_start,
        lease_end: u.lease_end,
        occupancy_status: u.occupancy_status,
        ejari_no: u.ejari_no,
        source_document_id: doc.id,
        source_row: u.source_row,
        confidence: u.confidence,
      })),
    );
  }

  const t12 = payload.t12_lines ?? [];
  if (t12.length) {
    replaceT12(
      dealId,
      ownerId,
      t12.map((l, index) => {
        // Deterministic normalisation pass, applied to BOTH extraction paths.
        //
        // The AI prompt asks the model to mark one-off items as non-recurring,
        // but a prompt is a request, not a guarantee — and a lift-modernisation
        // levy or a legal settlement that slips into a stabilised NOI overstates
        // the deal for the entire hold. So the rule runs again here regardless
        // of which extractor produced the line.
        //
        // It only ever ADDS an exclusion. If the model already flagged a line
        // the reviewer's view of it is preserved, and nothing here can quietly
        // re-include something that was excluded.
        const detected = nonRecurringReason(l.raw_label);
        const isRecurring = l.is_recurring && detected === null;
        const excludeReason =
          l.exclude_reason ?? (detected !== null && l.is_recurring ? detected : null);

        return {
          ordinal: index + 1,
          raw_label: l.raw_label,
          section: l.section,
          // Fall back to the deterministic categoriser when the model left the
          // bucket empty, so an uncategorised line still reaches the right total.
          category: l.category ?? categoriseLabel(l.raw_label),
          amount: l.amount,
          months_covered: l.months_covered,
          annualized:
            typeof l.amount === "number" && l.months_covered > 0
              ? (l.amount / l.months_covered) * 12
              : null,
          is_recurring: isRecurring ? 1 : 0,
          exclude_reason: excludeReason,
          source_document_id: doc.id,
          source_row: l.source_row,
          confidence: l.confidence,
        };
      }),
    );
  }

  return { fields, units: units.length, t12: t12.length };
}

/**
 * The no-API-key extraction path. Re-reads the file from disk so the
 * deterministic extractor gets the classified tables, which are not persisted.
 */
async function ruleBasedOutcome(
  doc: DocumentRow,
  definition: ModelDefinition,
): Promise<ExtractionOutcomeShape> {
  const started = performance.now();

  if (doc.is_scanned === 1) {
    return {
      ok: false,
      engine: "rules",
      error:
        "This document has no text layer — it is a scan or a photograph. Enter its figures manually on the review screen.",
      durationMs: 0,
    };
  }

  try {
    const bytes = readFileSync(doc.storage_path);
    const parsed = await parseDocument(bytes, doc.filename, doc.kind);
    if (!parsed.ok) {
      return {
        ok: false,
        engine: "rules",
        error: parsed.error ?? "The document could not be re-read for extraction",
        durationMs: Math.round(performance.now() - started),
      };
    }
    return {
      ok: true,
      engine: "rules",
      payload: ruleBasedExtraction(parsed, definition),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      engine: "rules",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/** True when a language model is configured. Extraction runs either way. */
export function extractionAvailable(): boolean {
  return aiAvailable();
}
