import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { getSessionFilePresignedUrl } from "@fretik/shared/lib/chatbot-session-storage";
import { requiresOcrPreprocessing } from "@fretik/shared/utils/mimeTypes";
import { eq } from "drizzle-orm";
import { WORKSPACE_DIRS, writeFile } from "../../lib/conversation-storage";
import { flattenOcrMarkdown, runMistralOcr } from "../../lib/mistral-ocr";

/**
 * Chat-file preprocessor. Called synchronously from `upload.ts` once
 * the raw bytes have landed in the sandbox + S3 mirror. Dispatches
 * by MIME type:
 *
 *  - PDF / DOCX / PPTX → Mistral OCR, write flattened markdown as a
 *    `{stem}.md` sidecar inside `attachments/`, set
 *    `hasMarkdown = true`.
 *  - Images (PNG / JPEG / WEBP) → Mistral OCR. Keep the sidecar only
 *    when the extracted text crosses a 20-char non-whitespace
 *    heuristic — photos of documents gain a sidecar, generic photos
 *    do not.
 *  - Everything else (XLSX / CSV / TXT / MD / JSON / XML) →
 *    passthrough, `hasMarkdown = false`.
 *
 * Errors propagate to the caller (`upload.ts`) which flips the
 * `ai_chat_files` row to `status: 'error'` with the message. Running
 * OCR from the upload path (not a background worker) is deliberate:
 * the user uploaded the file and is waiting to attach it; a
 * synchronous round-trip matches the "show card → wait for ready"
 * UX spec.
 */

const IMAGE_OCR_MIN_NON_WHITESPACE_CHARS = 20;

const sidecarFilename = (filename: string): string => {
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return `${base}.md`;
};

interface PreprocessArgs {
  fileId: string;
  conversationId: string;
  filename: string;
  mimeType: string;
}

export interface PreprocessOutcome {
  hasMarkdown: boolean;
  /**
   * Page count from Mistral OCR when a sidecar was actually written.
   * Surfaced so `upload.ts` can pass it to `extractChatFileSnapshot`
   * without re-parsing the markdown — Mistral has it for free.
   */
  pageCount?: number;
  /**
   * Sandbox-relative path of the OCR sidecar when one was written
   * (e.g. `attachments/foo.md`). Lets `upload.ts` read the markdown
   * for snapshot extraction without re-running OCR.
   */
  sidecarPath?: string;
}

export const preprocessChatFile = async (
  args: PreprocessArgs,
): Promise<PreprocessOutcome> => {
  if (!requiresOcrPreprocessing(args.mimeType)) {
    return { hasMarkdown: false };
  }

  await db
    .update(aiChatFiles)
    .set({ status: "ocr" })
    .where(eq(aiChatFiles.id, args.fileId));

  // Mistral OCR fetches the original via a presigned S3 URL. The S3
  // key tracks the workspace-relative path written by `attachUserFile`
  // — `attachments/{filename}` under the conversation's session prefix.
  const attachmentS3Path = `${WORKSPACE_DIRS.attachments}/${args.filename}`;
  const url = await getSessionFilePresignedUrl(
    args.conversationId,
    attachmentS3Path,
  );
  const ocr = await runMistralOcr({ url, mimeType: args.mimeType });
  const markdown = flattenOcrMarkdown(ocr);

  const isImage = args.mimeType.startsWith("image/");
  const hasUsefulContent =
    markdown.replace(/\s+/g, "").length >= IMAGE_OCR_MIN_NON_WHITESPACE_CHARS;

  // Images only get a sidecar if OCR actually produced something
  // meaningful — a selfie or a logo should not spawn an empty .md.
  if (isImage && !hasUsefulContent) {
    return { hasMarkdown: false };
  }

  // Write the sidecar into the conversation sandbox under
  // `attachments/{stem}.md`. The façade also queues the async S3
  // backup so a sandbox recreated after expiry sees the sidecar.
  const sidecarPath = `${WORKSPACE_DIRS.attachments}/${sidecarFilename(args.filename)}`;
  await writeFile(args.conversationId, sidecarPath, markdown, {
    contentType: "text/markdown; charset=utf-8",
  });

  return { hasMarkdown: true, pageCount: ocr.pageCount, sidecarPath };
};
