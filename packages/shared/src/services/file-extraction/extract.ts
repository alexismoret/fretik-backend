import { and, eq } from "drizzle-orm";
import db from "../../db";
import { fileExtractions, type FileExtraction } from "../../db/schema";
import { canonicalExtensionFor, extensionOf } from "../../file-types";

import {
  flattenOcrMarkdown,
  MISTRAL_OCR_LIMIT_ERROR_MESSAGE,
  MISTRAL_OCR_MAX_FILE_BYTES,
  runMistralOcr,
  splitFlattenedMarkdown,
  type OcrResult,
} from "../../lib/mistral-ocr";
import { convertDocumentToPdf } from "../documents/convert";
import { extractEmailToMarkdown } from "./email";
import { convertHtmlToMarkdown } from "./html";
import { isCacheableRoute, routeForMime } from "./route";
import { parseSpreadsheet } from "./spreadsheet";
import {
  readExtractionSidecar,
  writeExtractionImages,
  writeExtractionSidecar,
} from "./storage";
import { parseAsText } from "./text";
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

/**
 * Render a `convert-ocr` document to PDF and inline it as a data URL.
 * Mistral fetches `documentUrl` itself, so an ephemeral conversion has
 * to travel in the request rather than through a presigned S3 object.
 */
const toPdfDataUrl = async (
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> => {
  const extension =
    canonicalExtensionFor(mimeType) ?? extensionOf(filename) ?? "";
  const pdf = await convertDocumentToPdf(bytes, extension);
  return `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`;
};

/** Narrow the DB's `varchar` route back to the union without an `as` cast. */
const toExtractionRoute = (value: string): ExtractionRoute => {
  switch (value) {
    case "mistral-ocr":
    case "convert-ocr":
    case "image-ocr":
    case "image-skip":
    case "spreadsheet":
    case "email":
    case "html":
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

/** Routes whose markdown is a concatenation of real OCR pages. */
const PAGED_ROUTES: ReadonlySet<ExtractionRoute> = new Set([
  "mistral-ocr",
  "convert-ocr",
  "image-ocr",
  "legacy-import",
]);

/**
 * Every route owes its callers a page list, not just markdown: the Drive
 * pre-extract pipeline reads `pages` and treats an empty list as a failed
 * extraction. Paged routes split their sidecar back into OCR pages;
 * blob routes (text, html, email, spreadsheet) yield ONE synthetic page —
 * the same shape a `text/plain` document has always had.
 *
 * Applied on both the live and the cache-hit path so a file cannot
 * extract differently on its first pass than on its second.
 */
const pagesFor = (
  route: ExtractionRoute,
  markdown: string | null,
): ExtractionResult["pages"] =>
  markdown === null
    ? []
    : PAGED_ROUTES.has(route)
      ? splitFlattenedMarkdown(markdown)
      : [{ index: 0, markdown }];

/** Build a result from a `ready` cache row (reads the sidecar from S3). */
const resultFromReadyRow = async (
  row: FileExtraction,
): Promise<ExtractionResult> => {
  const markdown = row.sidecarS3Key
    ? await readExtractionSidecar(row.sidecarS3Key)
    : null;
  const route = toExtractionRoute(row.route);
  return {
    route,
    markdown,
    // Pages are only needed by Drive; reconstruct them from the
    // flattened sidecar on a cache hit (the live path keeps exact pages).
    pages: pagesFor(route, markdown),
    pageCount: row.pageCount,
    charCount: row.charCount,
    sidecarS3Key: row.sidecarS3Key,
    // NULL = legacy row extracted before image support — served as
    // image-less, never re-extracted.
    imageIds: row.imageIds ?? [],
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
        imageIds: [],
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
    imageIds: [],
    error: "extraction timed out waiting for a concurrent run",
  };
};

interface RunOutcome {
  route: ExtractionRoute;
  markdown: string | null;
  pages: ExtractionResult["pages"];
  pageCount: number | null;
  charCount: number | null;
  /** Ids of the embedded images actually stored on S3. */
  imageIds: string[];
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
        imageIds: [],
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
      pages: pagesFor(route, sheet.content),
      pageCount: sheet.sheetCount,
      charCount: sheet.content.length,
      imageIds: [],
    };
  }

  if (route === "email") {
    const bytes = await input.getBytes();
    const mail = await extractEmailToMarkdown(bytes, input.mimeType);
    return {
      route,
      markdown: mail.markdown,
      pages: pagesFor(route, mail.markdown),
      pageCount: null,
      charCount: mail.markdown.length,
      imageIds: [],
    };
  }

  if (route === "html") {
    const bytes = await input.getBytes();
    const markdown = convertHtmlToMarkdown(new TextDecoder().decode(bytes));
    return {
      route,
      markdown,
      pages: pagesFor(route, markdown),
      pageCount: null,
      charCount: markdown.length,
      imageIds: [],
    };
  }

  // OCR routes (mistral-ocr, convert-ocr, image-ocr). Embedded images are
  // extracted for documents only — crops of a standalone photo are noise.
  //
  // `convert-ocr` types (OpenDocument, RTF) have no native reader on
  // Mistral's side, so they are rendered to PDF first and handed over as
  // a data URL — the converted bytes are ephemeral and never hit S3.
  const isConverted = route === "convert-ocr";
  const url = isConverted
    ? await toPdfDataUrl(await input.getBytes(), input.mimeType, input.filename)
    : await input.getPresignedUrl();
  const ocr: OcrResult = await (input.onOcr ?? runMistralOcr)({
    url,
    mimeType: isConverted ? "application/pdf" : input.mimeType,
    extractImages: route === "mistral-ocr" || isConverted,
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
        imageIds: [],
      };
    }
  }

  const imageIds =
    ocr.images.length > 0
      ? await writeExtractionImages(
          input.organizationId,
          input.fileHash,
          ocr.images,
        )
      : [];

  return {
    route,
    markdown,
    pages: ocr.pages,
    pageCount: ocr.pageCount,
    charCount: markdown.length,
    imageIds,
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
      pages: pagesFor(route, markdown),
      pageCount: null,
      charCount: markdown.length,
      sidecarS3Key: null,
      imageIds: [],
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
      imageIds: [],
      error: `Unsupported file type for extraction: ${input.mimeType}`,
    };
  }

  // Defensive guard against the Mistral OCR file-size limit — a pure
  // function of the input, so no error row is persisted (each caller
  // re-checks for free). Only fires if upload caps exceed Mistral's.
  if (
    (route === "mistral-ocr" || route === "image-ocr") &&
    input.fileSizeBytes !== undefined &&
    input.fileSizeBytes > MISTRAL_OCR_MAX_FILE_BYTES
  ) {
    return {
      route,
      markdown: null,
      pages: [],
      pageCount: null,
      charCount: null,
      sidecarS3Key: null,
      imageIds: [],
      error: MISTRAL_OCR_LIMIT_ERROR_MESSAGE,
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
        imageIds: outcome.imageIds.length > 0 ? outcome.imageIds : null,
      })
      .where(eq(fileExtractions.id, claimed.id));

    return {
      route: outcome.route,
      markdown: outcome.markdown,
      pages: outcome.pages,
      pageCount: outcome.pageCount,
      charCount: outcome.charCount,
      sidecarS3Key,
      imageIds: outcome.imageIds,
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
      imageIds: [],
      error: message,
    };
  }
};
