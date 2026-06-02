import { tool } from "ai";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFileText,
  resolveWorkspacePath,
  WORKSPACE_DIRS,
} from "../lib/conversation-storage";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * Unified `read` tool. Mirrors Claude Code's `FileReadTool`:
 * line-based `offset` / `limit` (NOT character-based), line-numbered
 * content with real file line numbers, and an output shape of
 * `{ filePath, source, startLine, numLines, totalLines, content }`.
 *
 * Reads anything in the conversation's `/workspace/` sandbox:
 *
 *  - Chat attachments under `attachments/`
 *  - OCR markdown sidecars (auto-resolved for PDF/DOCX/PPTX/image
 *    requests)
 *  - Persisted-output files saved by other tools at
 *    `outputs/persisted/{toolCallId}.(json|txt)`
 *  - Drive documents pulled in on demand at `drive/`
 *  - Skill bundles at `skills/<name>/...`
 *  - Context files at `context/...`
 *  - Memory files at `memory/...`
 *
 * Path inputs accepted:
 *   - `attachments/invoice.pdf`             (workspace-relative)
 *   - `/workspace/attachments/invoice.pdf`  (absolute, stripped)
 *   - `invoice.pdf`                         (bare basename — assumed
 *                                            to live under
 *                                            `attachments/`)
 *
 * Anything that escapes `/workspace/` via `..` or absolute paths
 * outside the workspace is rejected with `PATH_OUT_OF_SANDBOX`.
 *
 * Extension routing:
 *
 *  - Text-like (.md, .txt, .json, .xml, .csv, .html, …): returns
 *    numbered-line content, source=`original`.
 *  - `.pdf`, `.docx`, `.pptx`: auto-resolves to `{basename}.md`
 *    sidecar, source=`ocr-sidecar`.
 *  - `.png`, `.jpg`, `.jpeg`, `.webp`: returns the sidecar if OCR
 *    produced useful text, otherwise a typed error pointing at
 *    `vision`.
 *  - `.xlsx`, `.xls`: returns the markdown-tables sidecar when one
 *    exists; otherwise a typed error pointing at `python`
 *    (`pandas.read_excel` / `openpyxl`).
 */

/**
 * Default number of lines returned when `limit` is not specified.
 * Matches claude-code's `FileReadTool` default. The byte cap below
 * (`MAX_READ_CHARS`) usually kicks in first on dense content (OCR
 * markdown, minified JSON, multi-page sidecars), naturally producing
 * paginated reads without an OCR-specific code path.
 */
const DEFAULT_READ_LINES = 2_000;

/**
 * Hard character safety cap on the slice before it is returned. When
 * exceeded, we truncate lines from the tail and emit a `notice` field
 * with explicit pagination guidance so the model knows to call back
 * with `offset` / `limit` (or switch to `python` for full-doc work).
 *
 * Sized at 30K chars (~7.5K tokens) — generous enough to fit a typical
 * skill body or a short attachment, tight enough that two reads in a
 * single turn don't exhaust the context window of a 200K-token model
 * (e.g. MiniMax M2.7) on multi-attachment / multi-turn flows. Earlier
 * iterations sat at 100K (mirroring claude-code) but observed context
 * overflow on 2-PDF conversations: 2 × 100K reads + system prompt +
 * history regularly hit 250K+ tokens. The model is free to bypass with
 * an explicit `limit` for legitimate full-doc cases.
 */
const MAX_READ_CHARS = 30_000;

/**
 * Persisted-output threshold for `read` results specifically. Slightly
 * above `MAX_READ_CHARS` to account for `cat -n` line-numbering
 * overhead (~7 chars/line padding) + the JSON envelope around
 * `{ filePath, source, content, ... }`. Reads almost never persist now
 * that the byte cap is 30K — kept as a defense-in-depth ceiling.
 */
const READ_PERSIST_THRESHOLD_CHARS = 120_000;

const TEXT_LIKE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".log",
  ".json",
  ".ndjson",
  ".xml",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
]);

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
 * Adds `cat -n` style line numbers to `content`, starting from
 * `startLine` (1-indexed). Matches claude-code's `addLineNumbers`:
 * 6-char right-padded number + tab + content. Line numbers reflect
 * the real file position (not slice-relative), so the model can
 * cite lines reliably across paginated reads.
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
  // Bare basename → assume the agent meant a chat attachment.
  // Anything with a slash or absolute prefix goes through the
  // standard workspace resolver.
  const startsWithSlash = rawPath.startsWith("/");
  const hasSubdir = rawPath.includes("/");
  const adjusted =
    !startsWithSlash && !hasSubdir
      ? `${WORKSPACE_DIRS.attachments}/${rawPath}`
      : rawPath;
  return resolveWorkspacePath(adjusted);
};

/**
 * Build a directive recovery hint for a `FILE_NOT_FOUND` based on the
 * resolved workspace path. Returns `undefined` when no prefix matches
 * so the field is dropped from the serialized response (per Vercel AI
 * SDK behavior). Anthropic's tool-design guidance: errors should
 * "communicate specific and actionable improvements, rather than
 * opaque error codes or tracebacks".
 */
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

export const createReadTool = () =>
  tool({
    description: [
      "Read a file from the conversation's sandbox at `/workspace/`. Returns line-numbered content (6-char line number + tab + content) so citations can reference real file lines.",
      "",
      "Usage:",
      "- Use to view a specific file you already know exists (filename came from an attachment, `listDocuments`, or a previous tool result).",
      "- Use `read(path, offset, limit)` to target a section in a large file (`offset` is 1-indexed, `limit` defaults to 2000 lines).",
      "- For searching across multiple files → use `bash` (`grep`, `find`, `head`, pipelines) — much faster.",
      "- For pandas / openpyxl / pypdf / programmatic processing → use `python` (mandatory for `.xlsx` / `.xls`).",
      "- For visual questions (layout, signatures, diagrams) → use `vision`.",
      "- For finding by topic when you don't know the path → use `searchKnowledge`.",
      "- Path inputs: `attachments/invoice.pdf` (workspace-relative, preferred), `/workspace/attachments/invoice.pdf` (absolute), or bare `invoice.pdf` (assumed under `attachments/`). Paths escaping `/workspace/` are rejected.",
      "- Extension routing is transparent — pass the original filename: PDF/DOCX/PPTX auto-resolve to the `{basename}.md` OCR sidecar; PNG/JPG/WEBP return the OCR sidecar if available else point at `vision`; XLSX/XLS return a markdown-tables sidecar if available else point at `python`.",
      `- A byte safety cap (~${(MAX_READ_CHARS / 1000).toFixed(0)}K chars) fires first on dense content; when it does, \`truncatedByBytes: true\` + a \`notice\` field tell you exactly how to paginate.`,
      "",
      "Output: `{ filePath, source, startLine, numLines, totalLines, content, truncatedByBytes?, notice? }`. When the slice is oversized it is saved to a `<persisted-output>` file and the envelope is returned instead — page through the rest with `offset` + `limit`.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative path (e.g. 'attachments/report.pdf') or absolute under '/workspace/'. PDF / DOCX / PPTX auto-resolve to `{basename}.md` OCR sidecar; pass the original filename and we handle the sidecar transparently. XLSX / XLS auto-resolve to a markdown-tables sidecar when available, else use `python`.",
        ),
      offset: z
        .number()
        .int()
        .positive()
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
      let finalRelative = resolved.relative;
      let finalAbsolute = resolved.absolute;
      let source: ReadSource = "original";

      // Sidecar resolution preserves the original's directory so a
      // file under `context/foo.pdf` resolves to `context/foo.md`,
      // not `attachments/foo.md`.
      const sidecarBase = resolveSidecarBasename(basename(resolved.relative));
      const sidecarRel = join(dirname(resolved.relative), sidecarBase);
      const sidecarResolved = resolveWorkspacePath(sidecarRel);

      if (OCR_SIDECAR_EXTENSIONS.has(ext)) {
        if (!sidecarResolved) {
          return {
            error: `Unable to resolve OCR sidecar path for ${basename(resolved.relative)}.`,
            code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
          };
        }
        if (!(await fileExists(conversationId, sidecarResolved.relative))) {
          return {
            error: `Binary ${ext} files cannot be read directly. No OCR sidecar found at ${sidecarResolved.absolute}. For tables use python with pdfplumber/python-docx/python-pptx; for visual layout use vision(file_path, question).`,
            code: TOOL_ERROR_CODES.NO_OCR_SIDECAR,
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
            error: `No OCR sidecar available for this image. Use vision(file_path, question) with a specific visual question if you need to inspect the image content.`,
            code: TOOL_ERROR_CODES.NO_OCR_SIDECAR,
            hint: "vision",
          };
        }
        finalRelative = sidecarResolved.relative;
        finalAbsolute = sidecarResolved.absolute;
        source = "ocr-sidecar";
      } else if (SPREADSHEET_EXTENSIONS.has(ext)) {
        if (
          !sidecarResolved ||
          !(await fileExists(conversationId, sidecarResolved.relative))
        ) {
          return {
            error: `Binary spreadsheet files (${ext}) cannot be read as text. Use python with pandas.read_excel('${resolved.absolute}') or openpyxl to inspect the data.`,
            code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
            hint: "python",
          };
        }
        finalRelative = sidecarResolved.relative;
        finalAbsolute = sidecarResolved.absolute;
        source = "ocr-sidecar";
      } else if (TEXT_LIKE_EXTENSIONS.has(ext) || ext === "") {
        // Plain text path — read directly. Detect the persisted-output
        // shape (toolCallId.(json|txt) under outputs/persisted/) so the
        // UI can label this slice as a recovered envelope.
        const persistedDir = `${WORKSPACE_DIRS.outputsPersisted}/`;
        if (
          resolved.relative.startsWith(persistedDir) &&
          /\.(json|txt)$/i.test(resolved.relative)
        ) {
          source = "persisted-output";
        }
      } else {
        return {
          error: `Extension ${ext} is not supported. Attach the file as text or use python for binary formats.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
        };
      }

      let text: string;
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

      // Line-based slicing (claude-code parity). offset is 1-indexed;
      // we convert to a 0-indexed array position. Input validation
      // (`z.number().positive()`) rules out offset=0.
      const lines = text.split("\n");
      const totalLines = lines.length;
      const startLine = offset ?? 1;
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

      // Byte safety cap: if the slice (even with the line bound)
      // exceeds MAX_READ_CHARS, drop lines from the tail until it
      // fits. Flag so the agent can refine.
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

      // When the slice is a partial view of a larger file (byte cap
      // truncated the slice OR the natural limit didn't reach EOF),
      // surface explicit pagination guidance. Without this, the model
      // has been observed to plan over the partial slice as if it
      // were complete and ship incomplete deliverables. Generic
      // across all file types — OCR sidecars, large CSV/JSON,
      // persisted-output files, anything that doesn't fit in one go.
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
