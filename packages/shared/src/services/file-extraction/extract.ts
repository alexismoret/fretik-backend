import { and, eq } from "drizzle-orm";
import db from "../../db";
import { fileExtractions, type FileExtraction } from "../../db/schema";
import { parseSpreadsheet } from "../../lib/file-parsing/spreadsheet";
import { parseAsText } from "../../lib/file-parsing/text";
import {
  flattenOcrMarkdown,
  runMistralOcr,
  splitFlattenedMarkdown,
  type OcrResult,
} from "../../lib/mistral-ocr";
import { isCacheableRoute, routeForMime } from "./route";
import { readExtractionSidecar, writeExtractionSidecar } from "./storage";
import type {
  ExtractFileInput,
  ExtractionResult,
  ExtractionRoute,
} from "./types";

/**
 * `getOrCreateExtraction` — the single entry point that turns an
 * uploaded file into model-readable markdown exactly once per
 * `(organizationId, fileHash)` and serves it from cache thereafter.
 *
 * Used by the chatbot `read` tool, the Drive pre-extract pipeline, and
 * the context-file extractor. See `./types.ts` for the contract.
 *
 *  - `text` route: parsed inline every call (cheap, never cached).
 *  - `mistral-ocr` / `image-ocr` / `spreadsheet`: cached in the
 *    `file_extractions` table + a content-addressed S3 `.md` sidecar.
 *    The UNIQUE `(organization_id, file_hash)` row doubles as a
 *    cross-replica lock — the first reader runs OCR while concurrent
 *    readers poll until `ready`.
 */

const IMAGE_OCR_MIN_NON_WHITESPACE_CHARS = 20;
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 60; // ~30s ceiling before a stalled extraction self-heals

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Narrow the DB's `varchar` route back to the union without an `as` cast. */
const toExtractionRoute = (value: string): ExtractionRoute => {
  switch (value) {
    case "mistral-ocr":
    case "image-ocr":
    case "image-skip":
    case "spreadsheet":
    case "text":
    case "legacy-import":
      return value;
    default:
      return "unsupported";
  }
};

const findRow = (
  organizationId: string,
  fileHash: string,
): Promise<FileExtraction | undefined> =>
  db.query.fileExtractions.findFirst({
    where: { organizationId, fileHash },
  });

/** Build a result from a `ready` cache row (reads the sidecar from S3). */
const resultFromReadyRow = async (
  row: FileExtraction,
): Promise<ExtractionResult> => {
  const markdown = row.sidecarS3Key
    ? await readExtractionSidecar(row.sidecarS3Key)
    : null;
  return {
    route: toExtractionRoute(row.route),
    markdown,
    // Pages are only needed by Drive; reconstruct them from the
    // flattened sidecar on a cache hit (the live path keeps exact pages).
    pages: markdown ? splitFlattenedMarkdown(markdown) : [],
    pageCount: row.pageCount,
    charCount: row.charCount,
    sidecarS3Key: row.sidecarS3Key,
  };
};

/** Poll an in-flight extraction owned by another reader until it settles. */
const pollUntilSettled = async (
  organizationId: string,
  fileHash: string,
): Promise<ExtractionResult> => {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    const row = await findRow(organizationId, fileHash);
    if (!row || row.status === "extracting") continue;
    if (row.status === "error") {
      return {
        route: toExtractionRoute(row.route),
        markdown: null,
        pages: [],
        pageCount: null,
        charCount: null,
        sidecarS3Key: null,
        error: row.errorMessage ?? "extraction failed",
      };
    }
    return resultFromReadyRow(row);
  }
  return {
    route: "unsupported",
    markdown: null,
    pages: [],
    pageCount: null,
    charCount: null,
    sidecarS3Key: null,
    error: "extraction timed out waiting for a concurrent run",
  };
};

interface RunOutcome {
  route: ExtractionRoute;
  markdown: string | null;
  pages: ExtractionResult["pages"];
  pageCount: number | null;
  charCount: number | null;
}

/** Run the actual extraction for a cache miss (we own the row). */
const runExtraction = async (
  input: ExtractFileInput,
  route: ExtractionRoute,
): Promise<RunOutcome> => {
  // Back-compat: import a pre-refonte sidecar instead of paying re-OCR.
  if (input.legacySidecarLookup) {
    const legacy = await input.legacySidecarLookup();
    if (legacy !== null) {
      return {
        route: "legacy-import",
        markdown: legacy,
        pages: splitFlattenedMarkdown(legacy),
        pageCount: splitFlattenedMarkdown(legacy).length,
        charCount: legacy.length,
      };
    }
  }

  if (route === "spreadsheet") {
    const bytes = await input.getBytes();
    const sheet = await parseSpreadsheet({
      bytes,
      mimeType: input.mimeType,
      filename: input.filename,
    });
    return {
      route,
      markdown: sheet.content,
      pages: [],
      pageCount: sheet.sheetCount,
      charCount: sheet.content.length,
    };
  }

  // OCR routes (mistral-ocr, image-ocr).
  const url = await input.getPresignedUrl();
  const ocr: OcrResult = await (input.onOcr ?? runMistralOcr)({
    url,
    mimeType: input.mimeType,
  });
  const markdown = flattenOcrMarkdown(ocr);

  if (route === "image-ocr") {
    const usable =
      markdown.replace(/\s+/g, "").length >= IMAGE_OCR_MIN_NON_WHITESPACE_CHARS;
    if (!usable) {
      // Generic photo / logo: record a sidecar-less row so we never
      // re-OCR it, and signal the caller to fall back to vision.
      return {
        route: "image-skip",
        markdown: null,
        pages: [],
        pageCount: ocr.pageCount,
        charCount: 0,
      };
    }
  }

  return {
    route,
    markdown,
    pages: ocr.pages,
    pageCount: ocr.pageCount,
    charCount: markdown.length,
  };
};

export const getOrCreateExtraction = async (
  input: ExtractFileInput,
): Promise<ExtractionResult> => {
  const { organizationId, fileHash } = input;

  // Cache lookup FIRST — content-addressed by `(org, hash)`. A ready
  // entry is returned regardless of the caller's MIME label so the same
  // bytes extracted on one surface (chat) are reused on another (Drive /
  // context) even when their declared MIME differs.
  const existing = await findRow(organizationId, fileHash);
  if (existing?.status === "ready") return resultFromReadyRow(existing);
  if (existing?.status === "extracting") {
    return pollUntilSettled(organizationId, fileHash);
  }
  // existing?.status === "error" falls through to a re-attempt below.

  const route = routeForMime(input.mimeType);

  // Cheap inline route — never cached, no DB row.
  if (route === "text") {
    const bytes = await input.getBytes();
    const markdown = parseAsText({ bytes, mimeType: input.mimeType });
    return {
      route,
      markdown,
      pages: [],
      pageCount: null,
      charCount: markdown.length,
      sidecarS3Key: null,
    };
  }
  if (!isCacheableRoute(route)) {
    return {
      route: "unsupported",
      markdown: null,
      pages: [],
      pageCount: null,
      charCount: null,
      sidecarS3Key: null,
      error: `Unsupported file type for extraction: ${input.mimeType}`,
    };
  }

  // Claim ownership: the UNIQUE (org, hash) constraint elects one winner.
  const [claimed] = existing
    ? // Re-attempt a previously errored row: flip it back to extracting.
      await db
        .update(fileExtractions)
        .set({ status: "extracting", errorMessage: null })
        .where(
          and(
            eq(fileExtractions.id, existing.id),
            eq(fileExtractions.status, "error"),
          ),
        )
        .returning()
    : await db
        .insert(fileExtractions)
        .values({
          organizationId,
          fileHash,
          mimeType: input.mimeType,
          route,
          status: "extracting",
        })
        .onConflictDoNothing({
          target: [fileExtractions.organizationId, fileExtractions.fileHash],
        })
        .returning();

  if (!claimed) {
    // Lost the race (or the errored row was grabbed by another reader).
    return pollUntilSettled(organizationId, fileHash);
  }

  try {
    const outcome = await runExtraction(input, route);
    const sidecarS3Key =
      outcome.markdown !== null
        ? await writeExtractionSidecar(
            organizationId,
            fileHash,
            outcome.markdown,
          )
        : null;

    await db
      .update(fileExtractions)
      .set({
        status: "ready",
        route: outcome.route,
        sidecarS3Key,
        pageCount: outcome.pageCount,
        charCount: outcome.charCount,
      })
      .where(eq(fileExtractions.id, claimed.id));

    return {
      route: outcome.route,
      markdown: outcome.markdown,
      pages: outcome.pages,
      pageCount: outcome.pageCount,
      charCount: outcome.charCount,
      sidecarS3Key,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(fileExtractions)
      .set({ status: "error", errorMessage: message })
      .where(eq(fileExtractions.id, claimed.id));
    return {
      route,
      markdown: null,
      pages: [],
      pageCount: null,
      charCount: null,
      sidecarS3Key: null,
      error: message,
    };
  }
};
