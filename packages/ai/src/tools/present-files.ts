import { mimeFromFilename } from "@fretik/shared/file-types";
import { uploadSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFile,
  resolveWorkspacePath,
  WORKSPACE_DIRS,
} from "../lib/conversation-storage";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * `presentFiles` — surface one or more generated files to the user as
 * rich cards / inline image previews in the chat.
 *
 * The agent produces files in the conversation sandbox (via `python`
 * or `bash`, typically under `outputs/`), then calls this tool with
 * the list of paths. Each file is:
 *   1. Validated against the workspace (must resolve under
 *      `/workspace/`, must NOT be under `skills/` or `drive/` —
 *      those trees are read-only and not user deliverables).
 *   2. Read from the sandbox via the storage façade.
 *   3. Uploaded to the S3 session mirror (idempotent overwrite) so the
 *      download endpoint can serve it after the sandbox expires.
 *   4. Described with `{ filename, mimeType, size }` — the frontend
 *      builds the download URL and chooses a rendering mode (inline
 *      image vs. document card) from `mimeType`.
 *
 * Design parity with Anthropic's API skills model: upstream skills
 * deliver files via `bash_code_execution_tool_result.file_id` and the
 * claude.ai client decides rendering from the file's content-type.
 * This tool is the equivalent hand-off for our own sandbox.
 *
 * Rendering rule (documented in SKILL.md bodies):
 *  - image/* → inline preview (no "Open with …" buttons)
 *  - else → document card with Download + "Open with Excel/Word/
 *    PowerPoint" (Office URL scheme) + View (PDF).
 */

/**
 * Top-level workspace dirs the agent must NOT present — these are
 * read-only system trees, not user-facing deliverables. The agent can
 * read them, copy artifacts out, but can't surface them directly.
 */
const READ_ONLY_PRESENT_BLOCKLIST = new Set<string>([
  WORKSPACE_DIRS.skills,
  WORKSPACE_DIRS.drive,
  WORKSPACE_DIRS.context,
  WORKSPACE_DIRS.memory,
]);

/**
 * Type the agent's own output from its filename — the file was produced
 * in the sandbox, so nothing declares a MIME for it. Anything outside
 * the registry falls back to `application/octet-stream`: the frontend
 * renders a generic document card with a Download button and no
 * "Open with …" action.
 */
const resolveMimeType = mimeFromFilename;

export interface PresentedFile {
  /** Workspace-relative path (e.g. `outputs/chart.png`). */
  path: string;
  /** Last segment of the path, used as the user-visible filename. */
  filename: string;
  mimeType: string;
  size: number;
}

export interface PresentFilesOutput {
  files: PresentedFile[];
  message?: string;
  errors?: { path: string; code: string; message: string }[];
}

const basenameOf = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
};

export const createPresentFilesTool = () =>
  tool({
    description: [
      'Surface one or more files produced during this turn to the user as a rich file card (download + "Open with Excel / Word / PowerPoint" buttons) or an inline image preview (for PNG / JPG / SVG / WebP / GIF).',
      "",
      "Call this AFTER you have generated a file in the conversation sandbox — typically under `outputs/` via `python` following a bundled skill's playbook. Writing a file to the sandbox is not enough: it does not show anything to the user. `presentFiles` is what surfaces the deliverable.",
      "",
      "Inputs:",
      '- paths (required): list of workspace-relative or absolute paths under `/workspace/` (e.g. ["outputs/monthly-report.xlsx", "outputs/chart.png"]). Max 10. Paths under `skills/`, `drive/`, `context/`, `memory/` are REJECTED — those trees are read-only.',
      "- message (optional): short one-line caption shown above document cards. Do NOT pass a message when the list contains only images — the image renders inline and speaks for itself; a redundant caption reads as noise.",
      "",
      "Output shape: { files: [{ path, filename, mimeType, size }], message?, errors? }. The frontend builds the download URL from `${AI_URI}/chatbot-files/conversation/{conversationId}/files/{path}/download` and picks the rendering mode from `mimeType`: image/* → inline preview, everything else → document card.",
      "",
      "Files are uploaded to S3 (session mirror) as part of this call so they survive sandbox expiry. The local copy in the sandbox is not moved or deleted.",
    ].join("\n"),
    inputSchema: z.object({
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe(
          "Workspace-relative or absolute paths under `/workspace/`. Max 10. Paths under skills/, drive/, context/, or memory/ are rejected.",
        ),
      message: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Optional short caption shown above document file cards. Omit for image-only outputs — the image speaks for itself.",
        ),
    }),
    execute: async (
      { paths, message },
      options,
    ): Promise<PresentFilesOutput> => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          files: [],
          errors: [
            {
              path: "",
              code: TOOL_ERROR_CODES.NO_CONVERSATION,
              message:
                "presentFiles is only available inside a conversation. No conversationId in the current context.",
            },
          ],
        };
      }
      const conversationId = ctx.conversationId;

      const files: PresentedFile[] = [];
      const errors: NonNullable<PresentFilesOutput["errors"]> = [];

      for (const requested of paths) {
        const resolved = resolveWorkspacePath(requested);
        if (!resolved) {
          errors.push({
            path: requested,
            code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
            message: `Path is outside the conversation's sandbox (/workspace/).`,
          });
          continue;
        }

        const head = resolved.relative.split("/")[0];
        if (head !== undefined && READ_ONLY_PRESENT_BLOCKLIST.has(head)) {
          errors.push({
            path: requested,
            code: TOOL_ERROR_CODES.READ_ONLY_PATH,
            message: `${head}/ is a read-only tree — only files you generated yourself in attachments/ or outputs/ can be presented.`,
          });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        if (!(await fileExists(conversationId, resolved.relative))) {
          errors.push({
            path: requested,
            code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
            message: `File not found in the conversation sandbox: ${requested}.`,
          });
          continue;
        }

        let bytes: Uint8Array;
        try {
          // eslint-disable-next-line no-await-in-loop
          bytes = await readFile(conversationId, resolved.relative);
        } catch (err) {
          errors.push({
            path: requested,
            code: TOOL_ERROR_CODES.READ_FAILED,
            message: `Failed to read ${requested} from the sandbox: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          continue;
        }

        const filename = basenameOf(resolved.relative);

        try {
          // eslint-disable-next-line no-await-in-loop
          await uploadSessionFile(conversationId, resolved.relative, bytes);
        } catch (err) {
          errors.push({
            path: requested,
            code: TOOL_ERROR_CODES.S3_UPLOAD_FAILED,
            message: `Failed to mirror ${filename} to the session store: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          continue;
        }

        files.push({
          path: resolved.relative,
          filename,
          mimeType: resolveMimeType(filename),
          size: bytes.byteLength,
        });
      }

      const output: PresentFilesOutput = { files };
      if (message !== undefined) output.message = message;
      if (errors.length > 0) output.errors = errors;
      return output;
    },
  });
