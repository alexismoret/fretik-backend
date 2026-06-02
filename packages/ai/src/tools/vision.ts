import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFile,
  resolveWorkspacePath,
} from "../lib/conversation-storage";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { describeVisionFile } from "../lib/vision";

/**
 * `vision` tool — sends an image or PDF from the conversation's
 * sandbox to a vision sub-model (Google Gemini 3.1 Flash Lite
 * Preview by default, env override `OPENROUTER_VISION_MODEL`) with a
 * caller-supplied question, and returns the description.
 *
 * Designed to be RARE. Most uploaded files in the Fretik chatbot are
 * scans of documents — the OCR sidecar covers them at zero
 * incremental cost and `read(file_path)` is the cheaper default. Use
 * this tool only when the user's question is explicitly visual
 * (layout, diagram, colours, signatures, photo content, document
 * structure) and `read` cannot plausibly answer.
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
]);

const SUPPORTED_VISION_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
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
    default:
      return null;
  }
};

export const createVisionTool = () =>
  tool({
    description: [
      "Invokes a vision model to look at an image or PDF file in the conversation's sandbox and answer a specific visual question about it.",
      "",
      "USE SPARINGLY. For scans or screenshots of documents (invoices, receipts, contracts), try `read(file_path)` first — OCR has already extracted the text into a markdown sidecar. Only call vision when the question is explicitly visual: layout, diagrams, colours, photo content, positional details, signatures, or the overall document structure as a picture.",
      "",
      "Inputs:",
      "- file_path (required): workspace-relative or absolute path under `/workspace/` (e.g. 'attachments/chart.png', 'drive/uuid-report.pdf').",
      "- question (required): the specific visual question to ask. Be precise — 'Describe the chart in the bottom-right, including colours and values' works better than 'Describe this file'.",
      "",
      "Accepted formats: .png, .jpg, .jpeg, .webp, .pdf. Anything else returns an error.",
      "PDFs are sent natively to the vision model (not OCR-converted) so layout, diagrams, and signatures are preserved.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative or absolute path under '/workspace/'. Accepts .png, .jpg, .jpeg, .webp, .pdf.",
        ),
      question: z
        .string()
        .min(1)
        .describe(
          "The specific visual question to ask about the file. Required.",
        ),
    }),
    execute: async ({ file_path, question }, options) => {
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

      const ext = getExtension(resolved.relative);
      if (!SUPPORTED_VISION_EXTENSIONS.has(ext)) {
        return {
          error: `Not a supported vision format (${ext || "no extension"}). Use read instead — vision only accepts .png, .jpg, .jpeg, .webp, or .pdf.`,
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

      try {
        const result = await describeVisionFile({
          bytes,
          mimeType,
          question,
        });
        return {
          filePath: resolved.absolute,
          mimeType,
          question: result.question,
          model: result.model,
          description: result.description,
        };
      } catch (err) {
        return {
          error: `Vision call failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.VISION_ERROR,
        };
      }
    },
  });
