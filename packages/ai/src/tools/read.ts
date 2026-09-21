import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { agentAccessFor, mimeFromFilename } from "@fretik/shared/file-types";
import {
  readContextOriginal,
  readContextSidecar,
} from "@fretik/shared/lib/ai-context-storage";
import {
  getSessionFilePresignedUrl,
  readSessionFile,
  sanitizeSessionPath,
  uploadSessionFile,
} from "@fretik/shared/lib/chatbot-session-storage";
import { getOrCreateExtraction } from "@fretik/shared/services/file-extraction/extract";
import {
  parseExtractedImagePath,
  rewriteExtractedImageRefs,
} from "@fretik/shared/services/file-extraction/image-refs";
import { tool } from "ai";
import { SHA256 } from "bun";
import { eq } from "drizzle-orm";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFile,
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
 *  - Files the agent downloaded, under `downloads/`
 *  - Persisted-output files saved by other tools at
 *    `outputs/persisted/{toolCallId}.(json|txt)`
 *  - Drive documents pulled in on demand at `drive/`
 *  - Workflow-run deliverables pulled in on demand at `runs/<runId>/`
 *  - Skill bundles at `skills/<name>/...`
 *  - Context files at `context/...`
 *  - Memory files at `memories/user/...` and `memories/team/...`
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

/**
 * An inlined binary: `data:<mime>;base64,` followed by enough payload to
 * matter. 200 characters is the floor — a tracking pixel or a tiny inline icon
 * costs nothing and reads as ordinary markup, while a real image runs to tens
 * of thousands and eats the whole slice.
 */
const DATA_URI_RE = /(data:[\w.+-]+\/[\w.+-]+;base64,)([A-Za-z0-9+/=]{200,})/g;

/**
 * Replace inlined base64 payloads with their size.
 *
 * The bytes are unusable to a reader — no model does anything with base64 — and
 * they are dense enough to consume a whole read on their own: a mockup whose
 * logo sat in one 30 000-character line returned a third of the file and none
 * of its structure. The `data:` prefix stays, so the markup still reads as
 * markup and the omission is visible where it happened.
 */
export const collapseDataUris = (
  text: string,
): { text: string; collapsed: number; charsOmitted: number } => {
  let collapsed = 0;
  let charsOmitted = 0;
  const folded = text.replace(
    DATA_URI_RE,
    (_match, prefix: string, payload: string) => {
      collapsed += 1;
      charsOmitted += payload.length;
      return `${prefix}…[${payload.length.toString()} chars of base64 omitted]`;
    },
  );
  return { text: folded, collapsed, charsOmitted };
};

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
const RUN_OUTPUT_RE = /^runs\/([0-9a-fA-F-]{36})\//;

const buildFileNotFoundHint = (relative: string): string | undefined => {
  const driveMatch = DRIVE_UUID_RE.exec(relative);
  if (driveMatch) {
    return `Call \`downloadDriveDocument({ documentIds: ["${driveMatch[1]}"] })\` first. Files under \`drive/\` exist only after a successful download in this conversation.`;
  }
  const runMatch = RUN_OUTPUT_RE.exec(relative);
  if (runMatch) {
    return `Call \`manageWorkflow({ action: "get_run", runId: "${runMatch[1]}" })\` first — it pulls that run's deliverables into \`runs/${runMatch[1]}/\` and names them.`;
  }
  if (relative.startsWith(`${WORKSPACE_DIRS.attachments}/`)) {
    return `Check the exact filename in the system prompt's <attached_files> block — case, extension, and spaces must match. Bare \`read("<filename>")\` is rewritten as \`${WORKSPACE_DIRS.attachments}/<filename>\`.`;
  }
  if (relative.startsWith(`${WORKSPACE_DIRS.downloads}/`)) {
    return `Downloads are named by the action that fetched them, not by you — pass the \`sandbox_path\` it returned, verbatim. \`bash("ls ${WORKSPACE_DIRS.downloads}")\` lists what actually landed.`;
  }
  if (relative.startsWith(`${WORKSPACE_DIRS.outputs}/`)) {
    return `The file may not have been generated yet. Check the stdout of the previous \`python\` / \`bash\` call for the actual output path.`;
  }
  if (relative.startsWith(`${WORKSPACE_DIRS.memories}/`)) {
    return `Memory paths mirror the \`memory\` tool's namespace: \`${WORKSPACE_DIRS.memories}/user/<path>\` or \`${WORKSPACE_DIRS.memories}/team/<path>\`. Call \`memory({ command: "view", path: "/memories/team/" })\` to list what exists.`;
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
    columns: { id: true, fileHash: true, mimeType: true, size: true },
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
  // How this type is reachable as text is declared once, in the file-type
  // registry — never re-derived from the extension here.
  const access = agentAccessFor(mimeType, name);

  // Plain text, source code, CSV, HTML, SVG: decode verbatim.
  if (access === "raw-text") {
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
  if (access === "tabular") {
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
  if (access === "opaque") {
    return {
      error: {
        error: `Video files (${mimeType}) have no extractable text. Use vision("${absolute}", "<question>") to analyse what happens in the video.`,
        code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
        hint: "vision",
      },
    };
  }

  // Documents / images: lazy content-addressed extraction.
  if (
    access === "ocr-sidecar" ||
    access === "email-sidecar" ||
    access === "image"
  ) {
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
          fileSizeBytes: row.size,
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
    // Point figure refs at their stored extracted images so the agent
    // can hand ONE figure to `vision` instead of the whole document.
    // Legacy cache rows (no stored images) keep their refs untouched.
    return {
      text:
        extraction.imageIds.length > 0
          ? rewriteExtractedImageRefs({
              markdown: extraction.markdown,
              virtualDir: `attachments/${name}`,
              imageIds: extraction.imageIds,
            })
          : extraction.markdown,
    };
  }

  return {
    error: {
      error: `This file type (${mimeType}) can't be read as text. Use python for binary formats, or vision for images.`,
      code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
    },
  };
};

/**
 * Resolve a document that lives ONLY in the sandbox — `downloads/`,
 * `outputs/`, `drive/`, `runs/` — to readable text.
 *
 * The SAME content-addressed extraction a chat attachment gets, because
 * `getOrCreateExtraction` is keyed by `(organizationId, fileHash)` and
 * never needed a DB row: what can be read out of a file is decided by
 * its bytes, not by who put it there. A PDF fetched from SharePoint and
 * the same PDF uploaded by the user hit ONE cache entry.
 *
 * Until this existed, a file with no `ai_chat_files` row was readable
 * only if some hydrator happened to have dropped a `{basename}.md` next
 * to it — so every file a provider downloaded came back as `File not
 * found`, pointing at a `<file_attachments>` block it was never in.
 */
const resolveSandboxDocumentContent = async (args: {
  conversationId: string;
  organizationId: string;
  relative: string;
  absolute: string;
}): Promise<ResolveResult> => {
  const { conversationId, organizationId, relative, absolute } = args;
  const name = basename(relative);
  // No DB row, so the filename is the only MIME signal — but the routing
  // it feeds is the registry's, the same one attachments use.
  const mimeType = mimeFromFilename(name);

  let bytes: Uint8Array;
  try {
    bytes = await readFile(conversationId, relative);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not exist|not found|missing/i.test(message)) {
      return {
        error: {
          error: `File not found: ${absolute}`,
          code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
          hint: buildFileNotFoundHint(relative),
        },
      };
    }
    return {
      error: {
        error: `Failed to read file: ${message}`,
        code: TOOL_ERROR_CODES.READ_ERROR,
      },
    };
  }

  const extraction = await withTraceSession(
    conversationId,
    { metadata: { filename: name }, tags: ["process:read-file"] },
    () =>
      getOrCreateExtraction({
        organizationId,
        fileHash: SHA256.hash(bytes, "hex"),
        mimeType,
        filename: name,
        fileSizeBytes: bytes.byteLength,
        getBytes: async () => bytes,
        getPresignedUrl: async () => {
          // OCR routes have Mistral fetch the file itself, so the bytes
          // must be on S3 under this conversation's prefix. The mirror
          // that normally puts them there is fire-and-forget and runs at
          // the END of the `python` call that wrote the file, so a `read`
          // in the next tool call can outrun it — and `drive/` / `runs/`
          // are never mirrored at all. This upload is idempotent and
          // closes both cases; the bytes are already in hand.
          await uploadSessionFile(conversationId, relative, bytes, mimeType);
          return getSessionFilePresignedUrl(conversationId, relative);
        },
        onOcr: runMistralOcr,
      }),
  );

  if (extraction.error) {
    return {
      error: {
        error: `Failed to read file: ${extraction.error}`,
        code: TOOL_ERROR_CODES.READ_ERROR,
        hint: "python",
      },
    };
  }
  if (extraction.markdown === null) {
    // Image with no usable text (a photo / logo).
    return {
      error: {
        error: `This image has no extractable text. Use vision("${absolute}", "<question>") with a specific visual question to inspect it.`,
        code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
        hint: "vision",
      },
    };
  }
  return {
    text:
      extraction.imageIds.length > 0
        ? rewriteExtractedImageRefs({
            markdown: extraction.markdown,
            virtualDir: relative,
            imageIds: extraction.imageIds,
          })
        : extraction.markdown,
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
  const access = agentAccessFor(mimeType, name);

  // Plain text, source code, CSV, HTML, SVG: decode the bytes verbatim.
  if (access === "raw-text") {
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
  if (access === "tabular") {
    return {
      error: {
        error: `Spreadsheet files (${mimeType}) can't be read as text without losing formulas and types. Use python with pandas.read_excel('${absolute}') or openpyxl to inspect the data.`,
        code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
        hint: "python",
      },
    };
  }

  // Documents / images: return the markdown extracted at upload time.
  if (
    access === "ocr-sidecar" ||
    access === "email-sidecar" ||
    access === "image"
  ) {
    let markdown = file.content;
    if (markdown === null || markdown.length === 0) {
      const bytes = await readContextSidecar(file.profileId, file.id);
      markdown = bytes ? new TextDecoder().decode(bytes) : null;
    }
    if (markdown === null || markdown.length === 0) {
      if (access === "image") {
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
      "- View a file you already know exists (filename came from an attachment, `listDocuments`, or a previous tool result). Cross-tool routing (bash for multi-file scans, vision for visual questions, searchKnowledge for topic discovery) lives in `<tool_routing>`.",
      "- `read(path, offset, limit)` targets a section in a large file (`offset` is 1-indexed, `limit` defaults to 2000 lines).",
      "- Spreadsheets (`.xlsx` / `.xls`), programmatic processing, and MODIFYING a file (docx / pptx / xlsx editing) → use `python` (pandas, openpyxl, python-docx, python-pptx) — the original bytes are at `attachments/<filename>`; spreadsheets are NOT readable as text here.",
      "- Path inputs: `attachments/invoice.pdf` (workspace-relative, preferred), `/workspace/attachments/invoice.pdf` (absolute), or bare `invoice.pdf` (assumed under `attachments/`). Documents, mail and images are made readable transparently — just pass the original filename; source files (code, config, HTML) come back verbatim, markup included.",
      "- Document text may contain figure refs like `![chart](attachments/report.pdf/img-2.jpeg)` — pass that path to `vision` to look at THAT figure (it is not readable or python-openable).",
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
          error: `Path is outside the conversation's sandbox (/workspace/). Only files under attachments/, downloads/, outputs/, runs/, drive/, skills/, context/, or memories/ are readable.`,
          code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
        };
      }

      // Extracted figure (`<dir>/<file>/img-N.ext`): pixels, not text —
      // steer to `vision`, which resolves this exact path. Checked before
      // the per-directory split because any document that goes through
      // extraction can mint one, wherever it lives.
      if (parseExtractedImagePath(resolved.relative)) {
        return {
          error: `${resolved.relative} is an extracted figure, not text. View it with vision("${resolved.relative}", "<question>").`,
          code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
          hint: "vision",
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
        // Non-attachment workspace paths (downloads/, outputs/, drive/,
        // runs/, memories/): the bytes live in the sandbox. A binary is
        // resolved against the `{basename}.md` a hydrator may already have
        // dropped next to it — and, failing that, extracted from its own
        // bytes exactly as an attachment would be.
        const sidecarBase = resolveSidecarBasename(basename(resolved.relative));
        const sidecarRel = join(dirname(resolved.relative), sidecarBase);
        const sidecarResolved = resolveWorkspacePath(sidecarRel);

        // These files carry no DB row, so the extension is the only
        // signal — but the routing it feeds is the registry's, the same
        // one the attachment and context paths use.
        const pathAccess = agentAccessFor("", basename(resolved.relative));
        const sidecarExists =
          sidecarResolved !== null &&
          (await fileExists(conversationId, sidecarResolved.relative));

        // Set when the text came from extraction rather than from a file
        // on disk — there is then nothing left to read.
        let extractedText: string | null = null;

        if (
          pathAccess === "ocr-sidecar" ||
          pathAccess === "email-sidecar" ||
          pathAccess === "image"
        ) {
          if (sidecarResolved && sidecarExists) {
            // A hydrator already paid for this text — never re-extract.
            finalRelative = sidecarResolved.relative;
            finalAbsolute = sidecarResolved.absolute;
            source = "ocr-sidecar";
          } else if (pathAccess === "email-sidecar") {
            // Mail has no OCR route: `.msg` / `.eml` are containers, and
            // what the agent wants out of them (headers, body, the
            // attachments inside) is a parse, not a page render.
            return {
              error: `Mail files (${ext}) can't be read directly here. Use python with extract_msg (.msg) or the email module (.eml) to read the headers, body and attachments.`,
              code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
              hint: "python",
            };
          } else {
            const extracted = await resolveSandboxDocumentContent({
              conversationId,
              organizationId: ctx.organizationId,
              relative: resolved.relative,
              absolute: resolved.absolute,
            });
            if ("error" in extracted) return extracted.error;
            extractedText = extracted.text;
            source = "ocr-sidecar";
          }
        } else if (pathAccess === "tabular") {
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

        if (extractedText !== null) {
          text = extractedText;
        } else {
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
      }

      // Embedded bytes, folded before anything counts a line.
      //
      // Measured 2026-08-28: an HTML mockup the user attached carried its logo
      // as a single `data:image/png;base64,…` line of 30 000 characters — the
      // byte cap fired ON THAT LINE, so one `read` returned a third of the file
      // and nothing a reader could use. Base64 is not something the agent can
      // act on in any case: what it needs is the markup around it.
      const folded = collapseDataUris(text);
      text = folded.text;
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

      const notices: string[] = [];
      if (numLines < totalLines) {
        const nextOffset = startLine + numLines;
        notices.push(
          `Returned ${numLines.toString()} of ${totalLines.toString()} lines (lines ${startLine.toString()}–${(startLine + numLines - 1).toString()}).${truncatedByBytes ? ` Byte safety cap fired (${(MAX_READ_CHARS / 1000).toFixed(0)}K chars).` : ""} Call \`read("${finalRelative}", offset=${nextOffset.toString()})\` to continue, use \`extract\` for structured data across the whole document, or \`pd.read_csv(...)\` in \`python\` for tabular files.`,
        );
      }
      if (folded.collapsed > 0) {
        notices.push(
          `${folded.collapsed.toString()} inlined base64 ${folded.collapsed === 1 ? "payload was" : "payloads were"} folded to ${folded.charsOmitted.toString()} characters of markers — the file's own bytes are unchanged, and \`python\` reads them if you need them.`,
        );
      }
      if (notices.length > 0) payload.notice = notices.join(" ");

      return maybePersistLargeOutput(
        payload,
        conversationId,
        toolCallId,
        READ_PERSIST_THRESHOLD_CHARS,
      );
    },
  });
