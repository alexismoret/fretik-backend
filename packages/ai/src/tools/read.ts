import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import {
  readContextOriginal,
  readContextSidecar,
} from "@fretik/shared/lib/ai-context-storage";
import {
  getSessionFilePresignedUrl,
  readSessionFile,
  sanitizeSessionPath,
} from "@fretik/shared/lib/chatbot-session-storage";
import { getOrCreateExtraction } from "@fretik/shared/services/file-extraction/extract";
import {
  isImageMime,
  isOcrDocumentMime,
  isSpreadsheetMime,
  isTextMime,
  isVideoMime,
} from "@fretik/shared/utils/mimeTypes";
import { tool } from "ai";
import { SHA256 } from "bun";
import { eq } from "drizzle-orm";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFileText,
  resolveWorkspacePath,
  WORKSPACE_DIRS,
} from "../lib/conversation-storage";
import { runMistralOcr } from "../lib/mistral-ocr";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { withTraceSession } from "../lib/trace-tool";
import { loadAccessibleContext } from "../services/chatbot-context/load-context";
import { readSkillWorkspaceFile } from "../skills/read-skill-file";

/**
 * Unified `read` tool. Mirrors Claude Code's `FileReadTool`: line-based
 * `offset` / `limit` (NOT character-based), line-numbered content with
 * real file line numbers, and an output shape of `{ filePath, source,
 * startLine, numLines, totalLines, content }`.
 *
 * Reads anything in the conversation's `/workspace/` sandbox:
 *
 *  - Chat attachments under `attachments/`
 *  - Persisted-output files saved by other tools at
 *    `outputs/persisted/{toolCallId}.(json|txt)`
 *  - Drive documents pulled in on demand at `drive/`
 *  - Skill bundles at `skills/<name>/...`
 *  - Context files at `context/...`
 *  - Memory files at `memory/...`
 *
 * For chat attachments, extraction is TRANSPARENT and lazy: the model
 * passes the original filename and gets readable text back. Behind the
 * scenes documents (PDF / DOCX / PPTX) and images are extracted on the
 * first read and cached content-addressed by `(org, contentHash)` via
 * `@fretik/shared/services/file-extraction` — no sandbox round-trip, no
 * markdown artifact the model ever has to know about. Plain-text and
 * source-code files are returned verbatim. Spreadsheets are not read
 * here — they route to `python` (pandas/openpyxl) for full precision.
 *
 * Path inputs accepted:
 *   - `attachments/invoice.pdf`             (workspace-relative)
 *   - `/workspace/attachments/invoice.pdf`  (absolute, stripped)
 *   - `invoice.pdf`                         (bare basename — assumed
 *                                            under `attachments/`)
 *
 * Anything that escapes `/workspace/` is rejected with
 * `PATH_OUT_OF_SANDBOX`.
 */

/** Default lines returned when `limit` is omitted (claude-code parity). */
const DEFAULT_READ_LINES = 2_000;

/**
 * Hard character safety cap on the returned slice. When exceeded, lines
 * are dropped from the tail and a `notice` field gives explicit
 * pagination guidance. Sized at 30K chars (~7.5K tokens) so two reads in
 * a turn don't exhaust a 200K-token context on multi-attachment flows.
 */
const MAX_READ_CHARS = 30_000;

/** Defense-in-depth persisted-output ceiling for `read` results. */
const READ_PERSIST_THRESHOLD_CHARS = 120_000;

const OCR_SIDECAR_EXTENSIONS = new Set([".pdf", ".docx", ".pptx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls"]);

type ReadSource = "original" | "ocr-sidecar" | "persisted-output";

const resolveSidecarBasename = (filename: string): string => {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return `${stem}.md`;
};

/**
 * Adds `cat -n` style line numbers starting from `startLine` (1-indexed):
 * 6-char right-padded number + tab + content. Line numbers reflect the
 * real file position so citations stay stable across paginated reads.
 */
const addLineNumbers = ({
  content,
  startLine,
}: {
  content: string;
  startLine: number;
}): string => {
  if (!content) return "";
  return content
    .split(/\r?\n/)
    .map((line, i) => `${(i + startLine).toString().padStart(6, " ")}\t${line}`)
    .join("\n");
};

/**
 * Map a user-supplied path to a resolved workspace-relative path,
 * applying the bare-basename → `attachments/{name}` convenience.
 * Returns `null` when the path escapes `/workspace/`.
 */
const resolveReadPath = (
  rawPath: string,
): { relative: string; absolute: string } | null => {
  const startsWithSlash = rawPath.startsWith("/");
  const hasSubdir = rawPath.includes("/");
  const adjusted =
    !startsWithSlash && !hasSubdir
      ? `${WORKSPACE_DIRS.attachments}/${rawPath}`
      : rawPath;
  return resolveWorkspacePath(adjusted);
};

const DRIVE_UUID_RE = /^drive\/([0-9a-fA-F-]{36})-/;

const buildFileNotFoundHint = (relative: string): string | undefined => {
  const driveMatch = DRIVE_UUID_RE.exec(relative);
  if (driveMatch) {
    return `Call \`downloadDriveDocument({ documentId: "${driveMatch[1]}" })\` first. Files under \`drive/\` exist only after a successful download in this conversation.`;
  }
  if (relative.startsWith(`${WORKSPACE_DIRS.attachments}/`)) {
    return `Check the exact filename in the system prompt's <attached_files> block — case, extension, and spaces must match. Bare \`read("<filename>")\` is rewritten as \`${WORKSPACE_DIRS.attachments}/<filename>\`.`;
  }
  if (relative.startsWith(`${WORKSPACE_DIRS.outputs}/`)) {
    return `The file may not have been generated yet. Check the stdout of the previous \`python\` / \`bash\` call for the actual output path.`;
  }
  return undefined;
};

/** Typed error payload returned to the model in the `{ error, code }` shape. */
interface ReadErrorPayload {
  error: string;
  code: string;
  hint?: string;
}

type ResolveResult = { text: string } | { error: ReadErrorPayload };

/**
 * Resolve a chat-attachment to readable text — fully Bun-side, no E2B.
 * Routes by the file's REAL MIME (detected + stored at upload):
 *  - text / code / CSV → original bytes, decoded;
 *  - PDF / DOCX / PPTX / image → lazy content-addressed extraction;
 *  - XLSX / XLS → routed to `python`.
 */
const resolveAttachmentContent = async (args: {
  conversationId: string;
  organizationId: string;
  relative: string;
  absolute: string;
}): Promise<ResolveResult> => {
  const { conversationId, organizationId, relative, absolute } = args;
  const name = basename(relative);

  const row = await db.query.aiChatFiles.findFirst({
    where: { conversationId, filename: name },
    columns: { id: true, fileHash: true, mimeType: true },
  });
  if (!row) {
    return {
      error: {
        error: `File not found: ${absolute}`,
        code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
        hint: buildFileNotFoundHint(relative),
      },
    };
  }
  const mimeType = row.mimeType;

  // Plain text / source code / CSV (text/csv is text/*): decode verbatim.
  if (isTextMime(mimeType)) {
    const bytes = await readSessionFile(conversationId, relative);
    if (!bytes) {
      return {
        error: {
          error: `File not found: ${absolute}`,
          code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
        },
      };
    }
    return { text: new TextDecoder().decode(bytes) };
  }

  // Spreadsheets: code-execution is higher-precision than any text dump.
  if (isSpreadsheetMime(mimeType)) {
    return {
      error: {
        error: `Spreadsheet files (${mimeType}) can't be read as text without losing formulas and types. Use python with pandas.read_excel('${absolute}') or openpyxl to inspect the data.`,
        code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
        hint: "python",
      },
    };
  }

  // Videos: nothing to extract as text — route to the vision tool. (A
  // multimodal profile sees attached videos natively; this branch is for
  // the agent that explicitly tries to `read` one.)
  if (isVideoMime(mimeType)) {
    return {
      error: {
        error: `Video files (${mimeType}) have no extractable text. Use vision("${absolute}", "<question>") to analyse what happens in the video.`,
        code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
        hint: "vision",
      },
    };
  }

  // Documents / images: lazy content-addressed extraction.
  if (isOcrDocumentMime(mimeType) || isImageMime(mimeType)) {
    // Backfill a content hash for legacy rows uploaded before hashing.
    let fileHash = row.fileHash;
    if (!fileHash) {
      const bytes = await readSessionFile(conversationId, relative);
      if (!bytes) {
        return {
          error: {
            error: `File not found: ${absolute}`,
            code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
          },
        };
      }
      fileHash = SHA256.hash(bytes, "hex");
      await db
        .update(aiChatFiles)
        .set({ fileHash })
        .where(eq(aiChatFiles.id, row.id));
    }
    const contentHash = fileHash;

    // Legacy back-compat: import a pre-refonte session-prefix sidecar
    // instead of paying for a re-OCR (older conversations only).
    const legacySidecarRel = join(
      dirname(relative),
      resolveSidecarBasename(name),
    );

    const extraction = await withTraceSession(
      conversationId,
      { metadata: { filename: name }, tags: ["process:read-file"] },
      () =>
        getOrCreateExtraction({
          organizationId,
          fileHash: contentHash,
          mimeType,
          filename: name,
          getBytes: async () => {
            const bytes = await readSessionFile(conversationId, relative);
            if (!bytes) throw new Error(`Original bytes missing for ${name}`);
            return bytes;
          },
          getPresignedUrl: () =>
            getSessionFilePresignedUrl(conversationId, relative),
          onOcr: runMistralOcr,
          legacySidecarLookup: async () => {
            const bytes = await readSessionFile(
              conversationId,
              legacySidecarRel,
            );
            return bytes ? new TextDecoder().decode(bytes) : null;
          },
        }),
    );

    if (extraction.error) {
      return {
        error: {
          error: `Failed to read file: ${extraction.error}`,
          code: TOOL_ERROR_CODES.READ_ERROR,
        },
      };
    }
    if (extraction.markdown === null) {
      // Image with no usable text (a photo / logo).
      return {
        error: {
          error: `This image has no extractable text. Use vision(file_path, question) with a specific visual question to inspect it.`,
          code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
          hint: "vision",
        },
      };
    }
    return { text: extraction.markdown };
  }

  return {
    error: {
      error: `This file type (${mimeType}) can't be read as text. Use python for binary formats, or vision for images.`,
      code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
    },
  };
};

/**
 * Resolve a persistent context file to readable text — fully Bun-side,
 * no E2B. `read` is just an accelerator: any real processing
 * (spreadsheets, page-by-page work) still routes to `python` / `bash`,
 * which hydrate `context/` into the sandbox on demand. Context files
 * are extracted once at upload, so the markdown is read straight from
 * the `content` column / S3 sidecar — never re-OCR'd here. Routes by
 * the file's REAL MIME, mirroring `resolveAttachmentContent`.
 */
const resolveContextContent = async (args: {
  organizationId: string;
  teamId: string;
  userId: string | undefined;
  relative: string;
  absolute: string;
}): Promise<ResolveResult> => {
  const { organizationId, teamId, userId, relative, absolute } = args;
  const name = basename(relative);

  const accessible = await loadAccessibleContext({
    userId,
    teamId,
    organizationId,
  });
  const file = accessible.files.find(
    (f) => sanitizeSessionPath(f.filename) === name,
  );
  if (!file) {
    return {
      error: {
        error: `File not found: ${absolute}`,
        code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
        hint: "Check the exact filename in the system prompt's context manifest — case, extension, and spaces must match.",
      },
    };
  }
  if (file.status !== "ready") {
    return {
      error: {
        error: `Context file "${name}" is still processing (status: ${file.status}). Try again shortly.`,
        code: TOOL_ERROR_CODES.NOT_READY,
      },
    };
  }
  const mimeType = file.mimeType;

  // Plain text / source code / CSV: decode the original bytes verbatim.
  if (isTextMime(mimeType)) {
    const bytes = await readContextOriginal(
      file.profileId,
      file.id,
      extname(name),
    );
    if (!bytes) {
      return {
        error: {
          error: `File not found: ${absolute}`,
          code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
        },
      };
    }
    return { text: new TextDecoder().decode(bytes) };
  }

  // Spreadsheets: code-execution is higher-precision than any text dump.
  if (isSpreadsheetMime(mimeType)) {
    return {
      error: {
        error: `Spreadsheet files (${mimeType}) can't be read as text without losing formulas and types. Use python with pandas.read_excel('${absolute}') or openpyxl to inspect the data.`,
        code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
        hint: "python",
      },
    };
  }

  // Documents / images: return the markdown extracted at upload time.
  if (isOcrDocumentMime(mimeType) || isImageMime(mimeType)) {
    let markdown = file.content;
    if (markdown === null || markdown.length === 0) {
      const bytes = await readContextSidecar(file.profileId, file.id);
      markdown = bytes ? new TextDecoder().decode(bytes) : null;
    }
    if (markdown === null || markdown.length === 0) {
      if (isImageMime(mimeType)) {
        return {
          error: {
            error: `This image has no extractable text. Use vision(file_path, question) with a specific visual question to inspect it.`,
            code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
            hint: "vision",
          },
        };
      }
      return {
        error: {
          error: `Failed to read file: extracted text is not available for ${name}.`,
          code: TOOL_ERROR_CODES.READ_ERROR,
        },
      };
    }
    return { text: markdown };
  }

  return {
    error: {
      error: `This file type (${mimeType}) can't be read as text. Use python for binary formats, or vision for images.`,
      code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
    },
  };
};

export const createReadTool = () =>
  tool({
    description: [
      "Read a file from the conversation's workspace at `/workspace/` by path. Returns line-numbered content (6-char line number + tab + content) so citations can reference real file lines.",
      "",
      "Usage:",
      "- View a file you already know exists (filename came from an attachment, `listDocuments`, or a previous tool result).",
      "- `read(path, offset, limit)` targets a section in a large file (`offset` is 1-indexed, `limit` defaults to 2000 lines).",
      "- Searching across multiple files → use `bash` (`grep`, `find`, `head`, pipelines).",
      "- Spreadsheets (`.xlsx` / `.xls`) and programmatic / page-by-page processing → use `python` (pandas, openpyxl, pdfplumber).",
      "- Visual questions (layout, signatures, diagrams, photos) → use `vision`.",
      "- Finding by topic when you don't know the path → use `searchKnowledge`.",
      "- Path inputs: `attachments/invoice.pdf` (workspace-relative, preferred), `/workspace/attachments/invoice.pdf` (absolute), or bare `invoice.pdf` (assumed under `attachments/`). Documents and images are made readable transparently — just pass the original filename.",
      `- A byte safety cap (~${(MAX_READ_CHARS / 1000).toFixed(0)}K chars) fires on dense content; when it does, \`truncatedByBytes: true\` + a \`notice\` field tell you exactly how to paginate.`,
      "",
      "Output: `{ filePath, source, startLine, numLines, totalLines, content, truncatedByBytes?, notice? }`. When the slice is oversized it is saved to a `<persisted-output>` file and the envelope is returned instead — page through the rest with `offset` + `limit`.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative path (e.g. 'attachments/report.pdf') or absolute under '/workspace/'. Pass the original filename — documents and images are made readable transparently. Spreadsheets (.xlsx/.xls) route to `python` instead.",
        ),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "The line number to start reading from. Only provide if the file is too large to read at once.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `The number of lines to read. Only provide if the file is too large to read at once. Defaults to ${DEFAULT_READ_LINES.toLocaleString()}.`,
        ),
    }),
    execute: async ({ file_path, offset, limit }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      if (!ctx.conversationId) {
        return {
          error:
            "read is only available inside a conversation. No conversationId in the current context.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      const resolved = resolveReadPath(file_path);
      if (!resolved) {
        return {
          error: `Path is outside the conversation's sandbox (/workspace/). Only files under attachments/, outputs/, drive/, skills/, context/, or memory/ are readable.`,
          code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
        };
      }

      const ext = extname(resolved.relative).toLowerCase();
      const isAttachment = resolved.relative.startsWith(
        `${WORKSPACE_DIRS.attachments}/`,
      );
      const isSkill = resolved.relative.startsWith(`${WORKSPACE_DIRS.skills}/`);
      const isContext = resolved.relative.startsWith(
        `${WORKSPACE_DIRS.context}/`,
      );

      let text: string;
      let source: ReadSource = "original";
      let finalRelative = resolved.relative;
      let finalAbsolute = resolved.absolute;

      if (isAttachment) {
        // Chat attachments: transparent, Bun-side extraction (no E2B).
        const result = await resolveAttachmentContent({
          conversationId,
          organizationId: ctx.organizationId,
          relative: resolved.relative,
          absolute: resolved.absolute,
        });
        if ("error" in result) return result.error;
        text = result.text;
      } else if (isSkill) {
        // Skill bundles: served Bun-side (no E2B). SKILL.md bodies,
        // references, and scripts originate from this package's disk
        // (bundled / provider) or the `skills` DB row (team-uploaded);
        // the sandbox push of skill trees still happens at bootstrap so
        // `python` can load helper scripts via `skill_loader`.
        let skillText: string | null;
        try {
          skillText = await readSkillWorkspaceFile(
            conversationId,
            resolved.relative,
          );
        } catch (err) {
          return {
            error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
            code: TOOL_ERROR_CODES.READ_ERROR,
          };
        }
        if (skillText === null) {
          return {
            error: `File not found: ${resolved.absolute}`,
            code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
            hint: 'Check the exact skill name in the system prompt\'s skills catalogue. Read its instructions with `read("skills/<name>/SKILL.md")`.',
          };
        }
        text = skillText;
      } else if (isContext) {
        // Persistent context files: served Bun-side (no E2B). `read` is an
        // accelerator — extracted text comes straight from storage. Any
        // real processing (spreadsheets, etc.) routes to `python` / `bash`,
        // which hydrate `context/` into the sandbox on demand.
        const result = await resolveContextContent({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          userId: ctx.userId,
          relative: resolved.relative,
          absolute: resolved.absolute,
        });
        if ("error" in result) return result.error;
        text = result.text;
      } else {
        // Non-attachment workspace paths (drive/, outputs/, memory/): read
        // via the sandbox. Binary documents under these prefixes are
        // resolved against the `{basename}.md` text file dropped next to
        // them by their own hydrator.
        const sidecarBase = resolveSidecarBasename(basename(resolved.relative));
        const sidecarRel = join(dirname(resolved.relative), sidecarBase);
        const sidecarResolved = resolveWorkspacePath(sidecarRel);

        if (OCR_SIDECAR_EXTENSIONS.has(ext)) {
          if (
            !sidecarResolved ||
            !(await fileExists(conversationId, sidecarResolved.relative))
          ) {
            return {
              error: `Binary ${ext} files can't be read directly here. For tables use python (pdfplumber / python-docx / python-pptx); for visual layout use vision(file_path, question).`,
              code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
              hint: ext === ".pdf" ? "python-or-vision" : "python",
            };
          }
          finalRelative = sidecarResolved.relative;
          finalAbsolute = sidecarResolved.absolute;
          source = "ocr-sidecar";
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          if (
            !sidecarResolved ||
            !(await fileExists(conversationId, sidecarResolved.relative))
          ) {
            return {
              error: `This image has no extractable text. Use vision(file_path, question) with a specific visual question to inspect it.`,
              code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
              hint: "vision",
            };
          }
          finalRelative = sidecarResolved.relative;
          finalAbsolute = sidecarResolved.absolute;
          source = "ocr-sidecar";
        } else if (SPREADSHEET_EXTENSIONS.has(ext)) {
          return {
            error: `Spreadsheet files (${ext}) can't be read as text. Use python with pandas.read_excel('${resolved.absolute}') or openpyxl to inspect the data.`,
            code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
            hint: "python",
          };
        } else {
          // Text-like / persisted-output / anything else readable as UTF-8.
          const persistedDir = `${WORKSPACE_DIRS.outputsPersisted}/`;
          if (
            resolved.relative.startsWith(persistedDir) &&
            /\.(json|txt)$/i.test(resolved.relative)
          ) {
            source = "persisted-output";
          }
        }

        try {
          text = await readFileText(conversationId, finalRelative);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not exist|not found|missing/i.test(message)) {
            return {
              error: `File not found: ${finalAbsolute}`,
              code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
              hint: buildFileNotFoundHint(finalRelative),
            };
          }
          return {
            error: `Failed to read file: ${message}`,
            code: TOOL_ERROR_CODES.READ_ERROR,
          };
        }
      }

      // Line-based slicing (claude-code parity). offset is 1-indexed;
      // accept 0 permissively (0-indexed habit) and treat it as the start.
      const lines = text.split("\n");
      const totalLines = lines.length;
      const startLine = offset && offset > 0 ? offset : 1;
      const lineOffset = startLine - 1;

      if (lineOffset >= totalLines) {
        const payload = {
          filePath: finalAbsolute,
          source,
          startLine,
          numLines: 0,
          totalLines,
          content: "",
        };
        return maybePersistLargeOutput(
          payload,
          conversationId,
          toolCallId,
          READ_PERSIST_THRESHOLD_CHARS,
        );
      }

      const requestedLines = Math.min(
        limit ?? DEFAULT_READ_LINES,
        totalLines - lineOffset,
      );
      let slicedLines = lines.slice(lineOffset, lineOffset + requestedLines);
      let joined = slicedLines.join("\n");
      let truncatedByBytes = false;

      if (joined.length > MAX_READ_CHARS) {
        truncatedByBytes = true;
        let fittedLines = slicedLines.length;
        while (fittedLines > 1 && joined.length > MAX_READ_CHARS) {
          fittedLines -= 1;
          slicedLines = slicedLines.slice(0, fittedLines);
          joined = slicedLines.join("\n");
        }
        if (joined.length > MAX_READ_CHARS) {
          joined = joined.slice(0, MAX_READ_CHARS);
          slicedLines = [joined];
        }
      }

      const numLines = slicedLines.length;

      const payload: {
        filePath: string;
        source: ReadSource;
        startLine: number;
        numLines: number;
        totalLines: number;
        content: string;
        truncatedByBytes?: boolean;
        notice?: string;
      } = {
        filePath: finalAbsolute,
        source,
        startLine,
        numLines,
        totalLines,
        content: addLineNumbers({ content: joined, startLine }),
      };
      if (truncatedByBytes) payload.truncatedByBytes = true;

      if (numLines < totalLines) {
        const nextOffset = startLine + numLines;
        payload.notice = `Returned ${numLines.toString()} of ${totalLines.toString()} lines (lines ${startLine.toString()}–${(startLine + numLines - 1).toString()}).${truncatedByBytes ? ` Byte safety cap fired (${(MAX_READ_CHARS / 1000).toFixed(0)}K chars).` : ""} Call \`read("${finalRelative}", offset=${nextOffset.toString()})\` to continue, or process the file directly in \`python\` (e.g. \`pdfplumber.open(...)\`, \`pd.read_csv(...)\`) for full-doc work.`;
      }

      return maybePersistLargeOutput(
        payload,
        conversationId,
        toolCallId,
        READ_PERSIST_THRESHOLD_CHARS,
      );
    },
  });
