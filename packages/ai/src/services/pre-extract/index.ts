import { getFileFromS3, getPresignedUrl } from "@fretik/shared/lib/s3";
import type { PreExtractionResponse } from "@fretik/shared/schemas/pre-extraction";
import { type OcrPage, runMistralOcr } from "../../lib/mistral-ocr";
import { runPreextractLlm } from "./extract";

// ==================== //
// CONSTANTS            //
// ==================== //

/**
 * Upper bound on the concatenated OCR markdown we feed to the LLM. Above
 * this size we down-select pages (see `buildConsolidatedMarkdown`). 30 000
 * chars ≈ 7.5K tokens — a comfortable working set for gpt-oss-120b that
 * leaves plenty of context for the system prompt and the model's output.
 */
const LLM_MARKDOWN_CHAR_BUDGET = 30_000;

/**
 * Per-page cap applied AFTER down-selection when the total still exceeds
 * the budget. Keeps the 4 selected pages roughly balanced so no single
 * dense page eats the whole budget.
 */
const LLM_PAGE_CHAR_CAP = 7_500;

/** Cap on the number of chars read from `text/plain` files. */
const TEXT_PLAIN_CHAR_CAP = 30_000;

/** Validity window (seconds) of the S3 presigned URL handed to Mistral OCR. */
const PRESIGNED_URL_TTL_SECONDS = 600;

// ==================== //
// TYPES                //
// ==================== //

export interface PreExtractArgs {
  /** Document UUID — carried for logging only. */
  documentId: string;
  /**
   * S3 key of the file to pre-extract. Must be a PDF, an image, or a plain
   * text file. For Word/PowerPoint/Excel/CSV, the caller (shared) must have
   * uploaded a converted PDF to an ephemeral key BEFORE calling the route.
   */
  s3Key: string;
  /** MIME type matching the S3 object. Drives the OCR branch. */
  mimeType: string;
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
 *  - otherwise, keep pages [first, first+1, last-1, last] (dedup'd for
 *    short docs) and, if the result still exceeds the budget, cap each
 *    page to `LLM_PAGE_CHAR_CAP` chars.
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

  // Down-select: first, first+1, last-1, last (dedup + preserve order).
  const candidateIndices = new Set<number>();
  candidateIndices.add(0);
  if (pages.length > 1) candidateIndices.add(1);
  if (pages.length > 2) candidateIndices.add(pages.length - 2);
  if (pages.length > 0) candidateIndices.add(pages.length - 1);
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
export const runPreExtract = async (
  args: PreExtractArgs,
): Promise<PreExtractionResponse> => {
  const isPlainText = args.mimeType === "text/plain";

  // OCR (or raw text read) — measured separately so structured logs can
  // attribute latency between OCR, LLM, and the rest.
  const ocrStart = Date.now();
  let ocrPages: OcrPage[];

  if (isPlainText) {
    ocrPages = await readTextFile(args.s3Key);
  } else {
    const url = await getPresignedUrl(args.s3Key, PRESIGNED_URL_TTL_SECONDS);
    const ocr = await runMistralOcr({ url, mimeType: args.mimeType });
    ocrPages = ocr.pages;
  }
  const ocrMs = Date.now() - ocrStart;

  if (ocrPages.length === 0) {
    throw new Error(
      `OCR returned zero pages for document ${args.documentId} (s3Key=${args.s3Key})`,
    );
  }

  const { content, seenIndices } = selectPagesForLlm(ocrPages);
  const prompt = buildLlmPrompt({
    totalPages: ocrPages.length,
    seenIndices,
    content,
    isPlainText,
  });

  const llm = await runPreextractLlm({ prompt });

  // Structured log — one line per successful pre-extract, lets us
  // diagnose latency + model usage in production without re-running.
  console.info(
    `[pre-extract] documentId=${args.documentId} ocrMs=${ocrMs} llmMs=${llm.durationMs} tier=${llm.tier} model=${llm.modelId} pagesTotal=${ocrPages.length} pagesSent=${seenIndices.length} promptChars=${prompt.length} entities=${llm.output.entities.length} type=${llm.output.documentType} transportType=${llm.output.documentTransportType ?? "null"}`,
  );

  // Merge any LLM-provided metadata with our own diagnostic fields so
  // a future audit can trace which model / how long / how many chars
  // produced each DB row. The column is already JSONB so we don't
  // break the schema contract.
  const diagnosticMetadata: Record<string, unknown> = {
    ...(llm.output.preExtractionMetadata ?? {}),
    modelId: llm.modelId,
    modelTier: llm.tier,
    ocrMs,
    llmMs: llm.durationMs,
    pagesTotal: ocrPages.length,
    pagesSent: seenIndices.length,
    promptChars: prompt.length,
  };

  return {
    success: true,
    pages: ocrPages.map((p) => ({ index: p.index, markdown: p.markdown })),
    pageCount: ocrPages.length,
    documentType: llm.output.documentType,
    documentTransportType: llm.output.documentTransportType,
    transportMode: llm.output.transportMode,
    documentSummary: llm.output.documentSummary,
    documentLanguage: llm.output.documentLanguage,
    // LLM emits an ISO 8601 string; the response schema coerces to Date
    // (via `z.coerce.date()`) on the caller side, but we must construct
    // a Date here to satisfy the PreExtractionResponse TS type.
    documentDate: llm.output.documentDate
      ? new Date(llm.output.documentDate)
      : null,
    documentNumber: llm.output.documentNumber,
    entities: llm.output.entities,
    confidenceScore: llm.output.confidenceScore,
    preExtractionMetadata: diagnosticMetadata,
  };
};
