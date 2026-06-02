import {
  runMistralOcr as runMistralOcrRaw,
  type OcrResult,
  type RunOcrArgs,
} from "@fretik/shared/lib/mistral-ocr";
import {
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import { langfuseEnabled } from "./langfuse";

export {
  flattenOcrMarkdown,
  type OcrPage,
  type OcrResult,
  type RunOcrArgs,
} from "@fretik/shared/lib/mistral-ocr";

/**
 * Mistral OCR list price — $2 / 1000 pages. Mistral OCR returns no per-call
 * cost, so we derive it from the page count (Mistral bills per page).
 */
const MISTRAL_OCR_PRICE_PER_PAGE = 0.002;

/**
 * Mistral OCR with Langfuse tracing. Wraps the shared client (the Mistral SDK
 * bypasses OTel auto-instrumentation) in an `ocr` generation observation so
 * document OCR appears as a costed AI step like every other LLM call — cost =
 * pages × $0.002. Nests under the active trace (chatbot turn / pre-extract)
 * when present, otherwise a standalone root. Soft-fail: a tracing error never
 * breaks OCR; a no-op when Langfuse is unconfigured.
 */
export const runMistralOcr = async (args: RunOcrArgs): Promise<OcrResult> => {
  if (!langfuseEnabled) return runMistralOcrRaw(args);
  return startActiveObservation(
    "ocr",
    async () => {
      const result = await runMistralOcrRaw(args);
      try {
        updateActiveObservation(
          {
            input: { mimeType: args.mimeType },
            output: { pageCount: result.pageCount },
            model: "mistral-ocr-latest",
            usageDetails: { pages: result.pageCount },
            costDetails: {
              total: result.pageCount * MISTRAL_OCR_PRICE_PER_PAGE,
            },
          },
          { asType: "generation" },
        );
      } catch {
        // Telemetry must never break OCR.
      }
      return result;
    },
    { asType: "generation" },
  );
};
