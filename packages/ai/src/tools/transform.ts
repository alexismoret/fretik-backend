import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { extensionOf, typeForExtension } from "@fretik/shared/file-types";
import {
  getSessionFilePresignedUrl,
  readSessionFile,
} from "@fretik/shared/lib/chatbot-session-storage";
import { getOrCreateExtraction } from "@fretik/shared/services/file-extraction/extract";
import { tool } from "ai";
import { SHA256 } from "bun";
import { eq } from "drizzle-orm";
import { basename } from "node:path";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  readFileText,
  resolveWorkspacePath,
  WORKSPACE_DIRS,
  WORKSPACE_ROOT,
  writeFile,
} from "../lib/conversation-storage";
import { runMistralOcr } from "../lib/mistral-ocr";
import { planProseChunks, runProseTransform } from "../lib/prose-transform";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { withTraceSession } from "../lib/trace-tool";

/**
 * `transform` tool — document-scale prose transformation. The agent gives
 * a workspace text/document file plus a free-form instruction ("translate
 * to French, keep the markdown structure, use MACF for CBAM") and the
 * engine (`lib/prose-transform.ts`) applies it across the whole document
 * chunk-by-chunk, writing the result to a `/workspace/outputs` file.
 *
 * This is the first-class path for LENGTH-PRESERVING transformations of a
 * document's text — translate, rewrite, restyle, reformat, redact, clean
 * up. It exists because the model previously had no path for authoring
 * document-scale prose: asked to translate a 120K-char FAQ it wrote the
 * translation inside Python string literals across one doomed turn.
 *
 * It is a pure MAP (each chunk transformed in isolation, then
 * concatenated), so it is NOT for summarising/synthesising — those need a
 * reduce, which map+concat cannot do (it would yield disjoint
 * mini-summaries). The description routes those elsewhere.
 */

/**
 * Extensionless files and a couple of prose formats the registry does
 * not catalogue (`.rst`, `.tex`) are still valid transform input — they
 * are UTF-8 prose, which is all this tool needs.
 */
const EXTRA_TEXT_EXTENSIONS = new Set([".rst", ".tex", ".text", ""]);

/**
 * Pull prose out of a `.json` file. Persisted tool results (webFetch, a
 * persisted large output) are `{ ..., content: "<text>" }` — the CBAM
 * failure fetched a 147KB FAQ into exactly this shape. Returns the string
 * content field, or null when the JSON is not a prose envelope (structured
 * data belongs on `python`, not here).
 */
const extractJsonProse = (raw: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if ("content" in parsed && typeof parsed.content === "string") {
    return parsed.content;
  }
  if ("text" in parsed && typeof parsed.text === "string") {
    return parsed.text;
  }
  return null;
};

/**
 * Default output path: `outputs/<stem>-transformed.md`. A transformed
 * document is prose, so markdown is the right container regardless of the
 * source's extension.
 */
const defaultOutputPath = (sourceRelative: string): string => {
  const name = basename(sourceRelative);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${WORKSPACE_DIRS.outputs}/${stem}-transformed.md`;
};

export const createTransformTool = () =>
  tool({
    description: [
      "Applies a prose instruction to a whole document and writes the transformed text to an outputs/ file — a dedicated model rewrites the text chunk-by-chunk so nothing has to pass through your context.",
      "",
      "Reach for transform whenever the deliverable is a WHOLE document with its text changed but its length preserved: translate, rewrite/rephrase, change tone or register, reformat, redact/anonymise, fix grammar. It is the first-class path for these — NEVER author document-scale prose inside `python` string literals, and never re-read the source into your context to transform it by hand.",
      "",
      "NOT for summarising or synthesising (transform maps each section independently, so a summary would come back as disjoint fragments): a document that fits your context — summarise it directly in your reply; one too large — use `dispatchAgent`. NOT for extracting structured fields (use `extract`) or computing on tabular data (use `python`).",
      "",
      "Inputs:",
      "- file_path: ONE source under `/workspace/` — a text/markdown file, a persisted tool result (outputs/persisted/*.json, whose `content` is used), or a document (.pdf, .docx, .pptx, read via OCR).",
      "- instruction: exactly what to do to the text, in plain language. Put the target language, the tone, and any terminology/glossary here (e.g. 'Translate to French. Keep the markdown structure. Render CBAM as MACF.'). The more specific, the more consistent the result across sections.",
      "- output_path (optional): where to write, under `outputs/`. Defaults to `outputs/<source>-transformed.md`.",
      "",
      "Output: { outputPath, chars, chunks, complete, notices, model, preview }. ALWAYS check `complete` — when false, `notices` names the sections that failed or were truncated and how to re-run them. Present the result with `presentFiles([outputPath])`; do not read the whole output back into your context.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative or absolute path under '/workspace/' to ONE source file (e.g. 'attachments/faq.md', 'outputs/persisted/abc.json', 'attachments/contract.pdf').",
        ),
      instruction: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          "What to do to the text, in plain language — include the target language/tone and any terminology to enforce. E.g. 'Translate to French, keep the markdown structure, render CBAM as MACF.'",
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Optional destination under 'outputs/'. Defaults to 'outputs/<source>-transformed.md'.",
        ),
    }),
    execute: async ({ file_path, instruction, output_path }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          error:
            "transform is only available inside a conversation. No conversationId in the current context.",
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

      // Destination must also stay in the sandbox, under outputs/.
      const outRelative = output_path
        ? resolveWorkspacePath(output_path)?.relative
        : defaultOutputPath(resolved.relative);
      if (!outRelative) {
        return {
          error: `output_path is outside the conversation's sandbox (/workspace/).`,
          code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
        };
      }
      if (!outRelative.startsWith(`${WORKSPACE_DIRS.outputs}/`)) {
        return {
          error: `output_path must be under 'outputs/' so the result is surfaced to the user.`,
          code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
        };
      }

      const ext = extensionOf(resolved.relative);
      const def = typeForExtension(ext);
      if (def?.agentAccess === "tabular") {
        return {
          error: `Spreadsheets are tabular data, not prose — process '${resolved.absolute}' with python (pandas), not transform.`,
          code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
          hint: "python",
        };
      }
      if (def?.agentAccess === "image") {
        return {
          error: `Images carry no text stream — describe '${resolved.absolute}' with vision instead.`,
          code: TOOL_ERROR_CODES.NO_TEXT_CONTENT,
          hint: "vision",
        };
      }

      // Resolve the source text.
      let sourceText: string;
      if (
        def?.agentAccess === "ocr-sidecar" ||
        def?.agentAccess === "email-sidecar"
      ) {
        // PDF/Office: transform's models have no native document path, so
        // ride the cached OCR markdown (same content-addressed extraction
        // `read`/`extract` use). Mirrors the Office branch of tools/extract.ts.
        const name = basename(resolved.relative);
        const row = await db.query.aiChatFiles.findFirst({
          where: { conversationId, filename: name },
          columns: { id: true, fileHash: true, mimeType: true, size: true },
        });
        if (!row) {
          return {
            error: `File not found in this conversation's attachments: ${resolved.absolute}. For Drive documents, downloadDriveDocument first.`,
            code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
          };
        }
        let fileHash = row.fileHash;
        if (!fileHash) {
          const bytes = await readSessionFile(
            conversationId,
            resolved.relative,
          );
          if (!bytes) {
            return {
              error: `File not found: ${resolved.absolute}`,
              code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
            };
          }
          fileHash = SHA256.hash(bytes, "hex");
          await db
            .update(aiChatFiles)
            .set({ fileHash })
            .where(eq(aiChatFiles.id, row.id));
        }
        const contentHash = fileHash;
        const extraction = await withTraceSession(
          conversationId,
          { metadata: { filename: name }, tags: ["process:transform-tool"] },
          () =>
            getOrCreateExtraction({
              organizationId: ctx.organizationId,
              fileHash: contentHash,
              mimeType: row.mimeType,
              filename: name,
              fileSizeBytes: row.size,
              getBytes: async () => {
                const bytes = await readSessionFile(
                  conversationId,
                  resolved.relative,
                );
                if (!bytes)
                  throw new Error(`Original bytes missing for ${name}`);
                return bytes;
              },
              getPresignedUrl: () =>
                getSessionFilePresignedUrl(conversationId, resolved.relative),
              onOcr: runMistralOcr,
            }),
        );
        if (extraction.error || extraction.pages.length === 0) {
          return {
            error: `Could not get text out of ${name}${extraction.error ? `: ${extraction.error}` : ""}.`,
            code: TOOL_ERROR_CODES.READ_ERROR,
          };
        }
        sourceText = extraction.pages.map((page) => page.markdown).join("\n\n");
      } else if (def?.textual || EXTRA_TEXT_EXTENSIONS.has(ext)) {
        let raw: string;
        try {
          raw = await readFileText(conversationId, resolved.relative);
        } catch (err) {
          return {
            error: `File not found or unreadable: ${resolved.absolute}${err instanceof Error ? ` (${err.message})` : ""}`,
            code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
          };
        }
        if (ext === ".json") {
          const prose = extractJsonProse(raw);
          if (prose === null) {
            return {
              error: `'${resolved.absolute}' is JSON without a text 'content' field — it is structured data, not a prose document. Process it with python, or point transform at a persisted webFetch/large-output result.`,
              code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
              hint: "python",
            };
          }
          sourceText = prose;
        } else {
          sourceText = raw;
        }
      } else {
        return {
          error: `Not a transformable source (${ext || "no extension"}). transform accepts text/markdown files, persisted .json results, and documents (.pdf, .docx, .pptx).`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
        };
      }

      if (sourceText.trim().length === 0) {
        return {
          error: `Source has no text to transform: ${resolved.absolute}`,
          code: TOOL_ERROR_CODES.EMPTY_SOURCE,
        };
      }

      try {
        const chunks = planProseChunks(sourceText);
        const result = await runProseTransform({ chunks, instruction });
        await writeFile(conversationId, outRelative, result.output);
        return {
          outputPath: `${WORKSPACE_ROOT}/${outRelative}`,
          chars: result.output.length,
          chunks: result.chunks,
          complete: result.complete,
          notices: result.notices,
          model: result.model,
          preview: result.output.slice(0, 500),
        };
      } catch (err) {
        return {
          error: `Transformation failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.TRANSFORM_ERROR,
        };
      }
    },
  });
