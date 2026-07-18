import db from "@fretik/shared/db";
import { parseExtractedImagePath } from "@fretik/shared/services/file-extraction/image-refs";
import {
  buildExtractionImageKey,
  extractedImageContentType,
  readExtractionImage,
} from "@fretik/shared/services/file-extraction/storage";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFile,
  resolveWorkspacePath,
} from "../lib/conversation-storage";
import {
  getPdfPageCount,
  parsePageSelection,
  slicePdfPages,
} from "../lib/pdf-pages";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { describeVisionFile, type DescribeFileResult } from "../lib/vision";

/**
 * Agent-facing guidance appended when the vision model stopped at its
 * output cap — without it a capped description is indistinguishable
 * from a complete one (the exact silent-truncation failure observed
 * live before this notice existed).
 */
const TRUNCATED_NOTICE =
  "Description hit the output cap — ask a narrower question, target specific pages with `pages`, or use `extract` for structured data.";

const buildVisionPayload = (
  filePath: string,
  mimeType: string,
  result: DescribeFileResult,
  notices: string[],
) => ({
  filePath,
  mimeType,
  question: result.question,
  model: result.model,
  description: result.description,
  truncated: result.truncated,
  ...(result.truncated || notices.length > 0
    ? {
        notice: [
          ...notices,
          ...(result.truncated ? [TRUNCATED_NOTICE] : []),
        ].join(" "),
      }
    : {}),
});

/**
 * `vision` tool — sends an image or PDF from the conversation's
 * sandbox to a vision sub-model (the model registry's `vision` role,
 * Google Gemini 3.1 Flash Lite by default) with a caller-supplied
 * question, and returns the description.
 *
 * Designed to be RARE. Most uploaded files in the Fretik chatbot are
 * documents — lazy OCR (cached content-addressed) serves their text
 * through `read`, the cheaper default. This tool is for explicitly
 * visual questions (layout, diagram, colours, signatures, photo
 * content) that `read` cannot plausibly answer — preferably on ONE
 * extracted figure (`attachments/<file>/img-N.ext`, resolved from the
 * extraction cache, no sandbox) rather than a whole PDF.
 *
 * PDF handling uses the OpenRouter `file-parser` plugin pinned to
 * `engine: "native"` so Gemini receives the raw PDF instead of the
 * default Mistral-OCR conversion — vision preserves layout,
 * diagrams, and signatures that OCR flattens away.
 *
 * The primary chat model never sees file bytes — we deliberately
 * keep the hot-path context cheap and isolate vision cost behind an
 * explicit tool call. Errors from the vision provider bubble up as
 * typed `error` fields so the agent can see and reason about them.
 */

const SUPPORTED_VISION_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".pdf",
  ".mp4",
  ".webm",
  ".mov",
]);

const SUPPORTED_VISION_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const getExtension = (path: string): string => {
  const dotIndex = path.lastIndexOf(".");
  return dotIndex > 0 ? path.slice(dotIndex).toLowerCase() : "";
};

const guessMimeFromExtension = (ext: string): string | null => {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    default:
      return null;
  }
};

export const createVisionTool = () =>
  tool({
    description: [
      "Invokes a vision model to look at an image, an extracted document figure, a PDF, or a video and answer a specific visual question about it.",
      "",
      "For document text, `read` is cheaper and exact — call vision only when the question is explicitly visual: layout, diagrams, colours, photo content, positional details, signatures, or what happens in a video.",
      "",
      "Target the smallest thing that answers the question:",
      "- One figure inside a document → its extracted-figure path from `read` output (e.g. 'attachments/report.pdf/img-2.jpeg'), NOT the whole PDF.",
      "- A standalone image or video → its file path.",
      "- The whole PDF → only when the question spans the document's layout (multi-page structure, where a signature sits).",
      "- A specific page or range → the `pages` param ('3', '2-9') instead of the whole document.",
      "",
      "Inputs:",
      "- file_path (required): workspace-relative or absolute path under `/workspace/` (e.g. 'attachments/chart.png', 'attachments/report.pdf/img-2.jpeg', 'drive/uuid-report.pdf', 'attachments/clip.mp4').",
      "- question (required): the specific visual question. 'Describe the chart in the bottom-right, including colours and values' works better than 'Describe this file'.",
      "- pages (optional, PDF only): 1-based selection like '2-9' — sends just those pages (cheaper, more focused).",
      "",
      "Do NOT call vision to extract text from a scan (`read` returns it), to pull structured fields or rows out of a document (`extract` returns validated JSON), or out of curiosity when nothing visual was asked — vision is a paid model call.",
      "",
      "Accepted formats: .png, .jpg, .jpeg, .webp, .pdf, .mp4, .webm, .mov, plus extracted-figure paths. PDFs and videos are sent natively (not OCR-converted) so layout, motion, diagrams, and signatures are preserved.",
      "",
      "Output: { description, model, truncated, notice? }. `truncated: true` means the description hit the output cap — narrow the question or target fewer pages.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative or absolute path under '/workspace/'. Accepts .png, .jpg, .jpeg, .webp, .pdf, .mp4, .webm, .mov, and extracted-figure paths ('attachments/<file>/img-N.jpeg').",
        ),
      question: z
        .string()
        .min(1)
        .describe(
          "The specific visual question to ask about the file. Required.",
        ),
      pages: z
        .string()
        .optional()
        .describe(
          "PDF only: 1-based page selection like '3', '2-9' or '1,4-6' — sends just those pages instead of the whole document (cheaper, more focused).",
        ),
    }),
    execute: async ({ file_path, question, pages }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          error:
            "vision is only available inside a conversation. No conversationId in the current context.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      const resolved = resolveWorkspacePath(file_path);
      if (!resolved) {
        return {
          error: `Path is outside the conversation's sandbox (/workspace/).`,
          code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
        };
      }

      // Extracted figure (`attachments/<file>/img-N.ext`): a virtual
      // path minted by `read` — the pixels live in the extraction cache
      // on S3, not in the sandbox. Resolved DB-first, zero E2B.
      const figure = parseExtractedImagePath(resolved.relative);
      if (figure) {
        const figureMiss = {
          error: `No extracted figure ${figure.imageId} for ${figure.attachmentFilename}. read("attachments/${figure.attachmentFilename}") shows the available figure refs.`,
          code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
        };
        const fileRow = await db.query.aiChatFiles.findFirst({
          where: { conversationId, filename: figure.attachmentFilename },
          columns: { fileHash: true },
        });
        if (!fileRow?.fileHash) return figureMiss;
        const extractionRow = await db.query.fileExtractions.findFirst({
          where: {
            organizationId: ctx.organizationId,
            fileHash: fileRow.fileHash,
          },
          columns: { imageIds: true },
        });
        if (!extractionRow?.imageIds?.includes(figure.imageId)) {
          return figureMiss;
        }
        const imageBytes = await readExtractionImage(
          buildExtractionImageKey(
            ctx.organizationId,
            fileRow.fileHash,
            figure.imageId,
          ),
        );
        if (!imageBytes) return figureMiss;
        const figureMime = extractedImageContentType(figure.imageId);
        try {
          const result = await describeVisionFile({
            bytes: imageBytes,
            mimeType: figureMime,
            question,
            filename: figure.imageId,
          });
          return buildVisionPayload(resolved.absolute, figureMime, result, []);
        } catch (err) {
          return {
            error: `Vision call failed: ${err instanceof Error ? err.message : String(err)}`,
            code: TOOL_ERROR_CODES.VISION_ERROR,
          };
        }
      }

      const ext = getExtension(resolved.relative);
      if (!SUPPORTED_VISION_EXTENSIONS.has(ext)) {
        return {
          error: `Not a supported vision format (${ext || "no extension"}). Use read instead — vision only accepts .png, .jpg, .jpeg, .webp, .pdf, .mp4, .webm, or .mov.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_VISION_TYPE,
        };
      }

      const mimeType = guessMimeFromExtension(ext);
      if (!mimeType || !SUPPORTED_VISION_MIMES.has(mimeType)) {
        return {
          error: `Unsupported MIME type for ${ext}.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_VISION_TYPE,
        };
      }

      if (!(await fileExists(conversationId, resolved.relative))) {
        return {
          error: `File not found: ${resolved.absolute}`,
          code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
        };
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(conversationId, resolved.relative);
      } catch (err) {
        return {
          error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.READ_ERROR,
        };
      }

      // Page targeting (PDF only): slice the requested pages so the
      // model sees just those instead of the whole document.
      const notices: string[] = [];
      if (pages !== undefined) {
        if (mimeType !== "application/pdf") {
          return {
            error: `"pages" only applies to PDFs — ${ext} files are sent whole.`,
            code: TOOL_ERROR_CODES.INVALID_PAGE_RANGE,
          };
        }
        const pagesTotal = await getPdfPageCount(bytes);
        if (pagesTotal === null) {
          notices.push(
            "This PDF could not be split into pages (encrypted or non-standard structure) — the whole document was sent instead of the requested range.",
          );
        } else {
          const selection = parsePageSelection(pages, pagesTotal);
          if ("error" in selection) {
            return {
              error: selection.error,
              code: TOOL_ERROR_CODES.INVALID_PAGE_RANGE,
            };
          }
          const sliced = await slicePdfPages(bytes, selection);
          if (sliced === null) {
            notices.push(
              "This PDF could not be split into pages — the whole document was sent instead of the requested range.",
            );
          } else {
            bytes = sliced;
          }
        }
      }

      try {
        const result = await describeVisionFile({
          bytes,
          mimeType,
          question,
          filename: resolved.relative.split("/").pop(),
        });
        return buildVisionPayload(resolved.absolute, mimeType, result, notices);
      } catch (err) {
        return {
          error: `Vision call failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.VISION_ERROR,
        };
      }
    },
  });
