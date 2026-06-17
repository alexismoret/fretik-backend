import type { FieldDefinition } from "@fretik/shared/db/schema";
import { buildDocumentOriginalKey } from "@fretik/shared/lib/document-storage";
import { getFileFromS3, getPresignedUrl } from "@fretik/shared/lib/s3";
import type { PreExtractionResponse } from "@fretik/shared/schemas/pre-extraction";
import { getOrCreateExtraction } from "@fretik/shared/services/file-extraction/extract";
import { type OcrPage, runMistralOcr } from "../../lib/mistral-ocr";
import { withPipelineTrace } from "../../lib/trace-tool";
import { runPreextractLlm } from "./extract";

// ==================== //
// CONSTANTS            //
// ==================== //

/**
 * Upper bound on the concatenated OCR markdown we feed to the LLM. Above
 * this size we down-select pages (see `selectPagesForLlm`). 80 000 chars
 * ≈ 20K tokens — comfortable for DeepSeek-V4-Flash (1M context) and
 * covers the vast majority of business docs in full. Increased from
 * 30 000 (the GPT-OSS-120B-era setting) so long contracts / multi-page
 * invoices no longer lose middle pages to down-selection. Latency
 * impact: ~+1-2s TTFT on long inputs; OCR remains the dominant cost.
 */
const LLM_MARKDOWN_CHAR_BUDGET = 80_000;

/**
 * Per-page cap applied AFTER down-selection when the total still exceeds
 * the budget. Keeps selected pages roughly balanced so no single dense
 * page eats the whole budget.
 */
const LLM_PAGE_CHAR_CAP = 7_500;

/**
 * Cap on the number of chars read from `text/plain` files. Sits just
 * below `LLM_MARKDOWN_CHAR_BUDGET` (with margin for the synthetic page
 * header) so long .txt files get the same coverage as PDFs.
 */
const TEXT_PLAIN_CHAR_CAP = 75_000;

/** Validity window (seconds) of the S3 presigned URL handed to Mistral OCR. */
const PRESIGNED_URL_TTL_SECONDS = 600;

// ==================== //
// TYPES                //
// ==================== //

export interface PreExtractArgs {
  /** Document UUID — used both for logging and to derive the S3 key. */
  documentId: string;
  /** Used to derive the default S3 key's extension. */
  originalFilename: string;
  /** MIME type matching the S3 object. Drives the OCR branch. */
  mimeType: string;
  /**
   * Optional override for the S3 key to OCR. When omitted, the service
   * derives `documents/{documentId}{ext}` from `originalFilename` — the
   * native location of the user-uploaded binary. For Word / PowerPoint /
   * Excel / CSV, the caller (shared) uploads a converted PDF to an
   * ephemeral key BEFORE calling the route and passes that key here.
   */
  overrideS3Key?: string;
  /** Owning organisation — isolation key for the shared extraction cache. */
  organizationId?: string;
  /**
   * Hex SHA-256 of the original document bytes — the dedup key into the
   * shared `file_extractions` cache. When present (with `organizationId`)
   * the OCR step reuses / populates the cross-surface cache; when absent
   * it falls back to a direct OCR call (no regression).
   */
  fileHash?: string;
  /**
   * Active team field definitions. Drives the runtime Zod schema (and
   * therefore the JSON Schema sent to the LLM): the universal universal
   * fields are stable across teams, but `customFields` is built from
   * these defs. Empty array → universal-only extraction.
   */
  fieldDefinitions: FieldDefinition[];
  /**
   * Owning team — drives the per-team workhorse model pick (C8b) for the
   * primary pre-extract LLM. Undefined falls back to the code default.
   */
  teamId?: string;
}

// ==================== //
// INTERNAL HELPERS     //
// ==================== //

/**
 * Reads a `text/plain` file from S3 and returns its truncated content as
 * a single synthetic OCR page. No Mistral call.
 */
const readTextFile = async (s3Key: string): Promise<OcrPage[]> => {
  const body = await getFileFromS3(s3Key);
  if (!body) {
    throw new Error(`File not found in storage at key ${s3Key}`);
  }
  const bytes = await body.transformToByteArray();
  const fullText = new TextDecoder("utf-8").decode(bytes);
  const truncated = fullText.slice(0, TEXT_PLAIN_CHAR_CAP);
  return [{ index: 0, markdown: truncated }];
};

/**
 * Down-selects OCR pages and formats them as a single markdown blob for
 * the LLM. Strategy:
 *  - if the full concatenation fits under `LLM_MARKDOWN_CHAR_BUDGET`,
 *    send every page prefixed by its page header (seen = all pages).
 *  - otherwise, keep the first 5 and last 3 pages (dedup'd for short
 *    docs) and, if the result still exceeds the budget, cap each page
 *    to `LLM_PAGE_CHAR_CAP` chars.
 *
 * Returns both the consolidated content AND the list of page indices the
 * model actually saw — the caller uses the indices to inject the
 * "you are seeing pages X" metadata line expected by the system prompt.
 */
const selectPagesForLlm = (
  pages: OcrPage[],
): { content: string; seenIndices: number[] } => {
  if (pages.length === 0) {
    return { content: "", seenIndices: [] };
  }

  const renderAll = (selected: OcrPage[], capPerPage: number | null): string =>
    selected
      .map((p) => {
        const md =
          capPerPage != null ? p.markdown.slice(0, capPerPage) : p.markdown;
        return `## Page ${p.index + 1}\n\n${md.trim()}`;
      })
      .join("\n\n---\n\n");

  // Fast path: everything fits.
  const fullContent = renderAll(pages, null);
  if (fullContent.length <= LLM_MARKDOWN_CHAR_BUDGET) {
    return {
      content: fullContent,
      seenIndices: pages.map((p) => p.index + 1),
    };
  }

  // Down-select: first 5 + last 3 (dedup + preserve order). Larger
  // window than before so contracts / multi-page invoices retain mid-
  // document context too. For very short docs the Set dedups naturally.
  const candidateIndices = new Set<number>();
  for (let i = 0; i < Math.min(5, pages.length); i++) candidateIndices.add(i);
  for (let i = Math.max(0, pages.length - 3); i < pages.length; i++) {
    candidateIndices.add(i);
  }
  const selectedPages = [...candidateIndices]
    .sort((a, b) => a - b)
    .map((i) => pages[i])
    .filter((p): p is OcrPage => p !== undefined);

  let content = renderAll(selectedPages, null);
  if (content.length > LLM_MARKDOWN_CHAR_BUDGET) {
    content = renderAll(selectedPages, LLM_PAGE_CHAR_CAP);
  }

  return {
    content,
    seenIndices: selectedPages.map((p) => p.index + 1),
  };
};

/**
 * Builds the user message sent to the LLM, including the metadata line
 * the system prompt relies on to avoid hallucinating unseen pages.
 */
const buildLlmPrompt = (args: {
  totalPages: number;
  seenIndices: number[];
  content: string;
  isPlainText: boolean;
}): string => {
  const header = args.isPlainText
    ? "Document is a plain-text file."
    : `Document has ${args.totalPages} page${args.totalPages === 1 ? "" : "s"} in total, you are seeing page${args.seenIndices.length === 1 ? "" : "s"} [${args.seenIndices.join(", ")}].`;
  return `${header}\n\n${args.content}`;
};

// ==================== //
// MAIN ENTRY           //
// ==================== //

/**
 * Full pre-extraction pipeline: OCR (or raw text read) → LLM structured
 * classification + entity extraction → merge into the response contract
 * consumed by `@fretik/shared/services/documents/upload.ts`.
 */
/**
 * Run the whole pre-extraction pipeline as ONE `pre-extract` trace (OCR + the
 * extraction LLM nested under it), grouped under a per-document session
 * (`documents:{documentId}`) so it shares the Sessions view with the
 * document's vectorisation — full per-document cost/timeline.
 */
export const runPreExtract = (
  args: PreExtractArgs,
): Promise<PreExtractionResponse> =>
  withPipelineTrace(
    "pre-extract",
    `documents:${args.documentId}`,
    {
      metadata: { documentId: args.documentId },
      tags: ["process:pre-extract"],
    },
    () => runPreExtractImpl(args),
  );

const runPreExtractImpl = async (
  args: PreExtractArgs,
): Promise<PreExtractionResponse> => {
  const isPlainText = args.mimeType === "text/plain";
  // Derive the S3 key from `documentId` + `originalFilename` unless the
  // caller pinned an ephemeral conversion key.
  const s3Key =
    args.overrideS3Key ??
    buildDocumentOriginalKey(args.documentId, args.originalFilename);

  // OCR (or raw text read) — measured separately so structured logs can
  // attribute latency between OCR, LLM, and the rest.
  const ocrStart = Date.now();
  let ocrPages: OcrPage[];

  if (isPlainText) {
    ocrPages = await readTextFile(s3Key);
  } else if (args.organizationId && args.fileHash) {
    // Route OCR through the shared content-addressed cache so a document
    // already extracted on another surface (chat attachment, context
    // file) is reused instead of re-OCR'd, and vice-versa. The cache key
    // is the ORIGINAL content hash even when OCR runs on a converted PDF
    // (`overrideS3Key`) — same source doc → same hash → same result.
    const extraction = await getOrCreateExtraction({
      organizationId: args.organizationId,
      fileHash: args.fileHash,
      mimeType: args.mimeType,
      filename: args.originalFilename,
      getBytes: async () => {
        const body = await getFileFromS3(s3Key);
        if (!body) throw new Error(`File not found in storage at key ${s3Key}`);
        return new Uint8Array(await body.transformToByteArray());
      },
      getPresignedUrl: () => getPresignedUrl(s3Key, PRESIGNED_URL_TTL_SECONDS),
      onOcr: runMistralOcr,
    });
    if (extraction.error) throw new Error(extraction.error);
    ocrPages = extraction.pages;
  } else {
    const url = await getPresignedUrl(s3Key, PRESIGNED_URL_TTL_SECONDS);
    const ocr = await runMistralOcr({ url, mimeType: args.mimeType });
    ocrPages = ocr.pages;
  }
  const ocrMs = Date.now() - ocrStart;

  if (ocrPages.length === 0) {
    throw new Error(
      `OCR returned zero pages for document ${args.documentId} (s3Key=${s3Key})`,
    );
  }

  const { content, seenIndices } = selectPagesForLlm(ocrPages);
  const prompt = buildLlmPrompt({
    totalPages: ocrPages.length,
    seenIndices,
    content,
    isPlainText,
  });

  const llm = await runPreextractLlm({
    prompt,
    fieldDefinitions: args.fieldDefinitions,
    teamId: args.teamId,
  });

  // Structured log — one line per successful pre-extract, lets us
  // diagnose latency + model usage in production without re-running.
  console.info(
    `[pre-extract] documentId=${args.documentId} ocrMs=${ocrMs} llmMs=${llm.durationMs} tier=${llm.tier} model=${llm.modelId} pagesTotal=${ocrPages.length} pagesSent=${seenIndices.length} promptChars=${prompt.length} entities=${llm.output.entities.length} customFieldKeys=${Object.keys(llm.output.customFields).length}`,
  );

  return {
    success: true,
    pages: ocrPages.map((p) => ({ index: p.index, markdown: p.markdown })),
    pageCount: ocrPages.length,
    documentSummary: llm.output.documentSummary,
    documentLanguage: llm.output.documentLanguage,
    entities: llm.output.entities.map((e) => ({
      name: e.name,
      role: e.role as PreExtractionResponse["entities"][number]["role"],
      type: e.type as PreExtractionResponse["entities"][number]["type"],
      confidence: e.confidence,
    })),
    confidenceScore: llm.output.confidenceScore,
    customFields: llm.output.customFields,
  };
};
