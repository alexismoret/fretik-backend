import { flattenOcrMarkdown, runMistralOcr } from "../mistral-ocr";
import { FileParsingError } from "./types";

/**
 * OCR branch of the file-parsing router. Wraps `runMistralOcr` with
 * the `FileParsingError` taxonomy so the router can handle every
 * failure mode uniformly.
 *
 * Mistral OCR natively accepts PDF, DOCX, PPTX and images (PNG /
 * JPEG / WebP) so no Gotenberg conversion step is needed for this
 * use case. A presigned S3 URL reachable from Mistral's servers is
 * mandatory — the Mistral SDK does not accept raw bytes for this
 * model.
 */

export interface OcrBranchInput {
  presignedUrl: string | undefined;
  mimeType: string;
}

export interface OcrBranchOutput {
  content: string;
  pageCount: number;
}

export const parseViaOcr = async (
  input: OcrBranchInput,
): Promise<OcrBranchOutput> => {
  if (!input.presignedUrl) {
    throw new FileParsingError(
      "ocr_missing_url",
      "OCR parsing requires a presigned S3 URL reachable from Mistral.",
    );
  }

  try {
    const ocr = await runMistralOcr({
      url: input.presignedUrl,
      mimeType: input.mimeType,
    });
    return {
      content: flattenOcrMarkdown(ocr),
      pageCount: ocr.pageCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FileParsingError("ocr_failed", `Mistral OCR failed: ${message}`);
  }
};
