import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
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
  fileExists,
  readFile,
  resolveWorkspacePath,
} from "../lib/conversation-storage";
import { runMistralOcr } from "../lib/mistral-ocr";
import { NATIVE_FILE_MAX_BYTES } from "../lib/model-registry/types";
import { getPdfPageCount, parsePageSelection } from "../lib/pdf-pages";
import {
  type ExtractSource,
  prepareExtractionSchema,
  runStructuredExtract,
} from "../lib/structured-extract";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { withTraceSession } from "../lib/trace-tool";

/**
 * `extract` tool — schema-validated structured extraction from a
 * document in the conversation's workspace. The agent supplies a JSON
 * Schema for one record; the engine (`lib/structured-extract.ts`) runs
 * a dedicated extraction model (registry role `extract`) over the file
 * with native layout (PDF/image) or the cached OCR markdown
 * (DOCX/PPTX), chunking large PDFs so no output cap silently drops
 * rows.
 *
 * This is the first-class path for "data out of a document". It exists
 * because the two improvised alternatives both failed in production:
 * python parsing scripts are layout-brittle and example-specific, and
 * `vision` (a description tool) silently truncated at its output cap.
 * Spreadsheets stay on `python` — deterministic parsing beats a model
 * on born-digital tabular files.
 */

const PDF_EXTENSION = ".pdf";
const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".pptx", ".ppt"]);
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);

const getExtension = (path: string): string => {
  const dotIndex = path.lastIndexOf(".");
  return dotIndex > 0 ? path.slice(dotIndex).toLowerCase() : "";
};

export const createExtractTool = () =>
  tool({
    description: [
      "Extracts structured data from a document into schema-validated JSON — a dedicated extraction model reads the file natively (layout preserved) and returns exactly the fields you specify.",
      "",
      "Reach for extract whenever the goal is DATA from a document (line items, table rows, header fields, named values), whatever its layout — never write a parsing script against a document's layout. Spreadsheets/CSV are the one exception: parse those with `python` (pandas).",
      "",
      "Inputs:",
      "- file_path: ONE document under `/workspace/` (.pdf, .docx, .pptx, .png, .jpg, .webp). One call per document — call extract in parallel for several files.",
      '- schema: a standard JSON Schema (draft-07) of ONE record — `{"type":"object","properties":{...}}` with nested objects/arrays, enum, const, and constraints as needed. Put extraction guidance in each field\'s `description` (where the value appears, units, exact format) — the extractor follows it literally. Scalar fields auto-admit null, so absent values come back null instead of invented.',
      "- shape: 'records' → a LIST, one object per occurrence (table row, line item, repeated block). 'record' → ONE object (header/summary fields). Header + line items in one call: shape 'record' with an array-of-objects property.",
      "- instructions (optional): what the document is, which table/section to target, rows to include or skip.",
      "- pages (optional, PDF only): 1-based selection like '2-9' or '1,4-6'. Omit to cover the whole document — large PDFs are chunked automatically.",
      "",
      "Output: { pagesTotal, pagesCovered, chunks, complete, notices, data }. ALWAYS check `complete` — when false, `notices` says exactly which pages to re-call and how. The returned data is already validated against your schema; process or aggregate it with `python` if needed, but never re-extract the same values another way.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative or absolute path under '/workspace/' to ONE document (e.g. 'attachments/invoice.pdf').",
        ),
      schema: z
        .record(z.string(), z.unknown())
        .describe(
          'A standard JSON Schema (draft-07) for ONE record — an object with "properties", e.g. {"type":"object","properties":{"invoice_no":{"type":"string"},"lines":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"amount":{"type":"number"}}}}}}. Nested objects/arrays, enum, const, and constraints (min/max, minLength, pattern, format) are all honoured; nullable idioms, $ref/$defs, and allOf are normalized automatically. Put extraction guidance in each field\'s "description" (where the value appears, units, exact format). Scalar fields auto-admit null, so an absent value comes back null, never invented.',
        ),
      shape: z
        .enum(["records", "record"])
        .describe(
          "'records' = list of objects, one per occurrence. 'record' = one object.",
        ),
      instructions: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "Extraction context: what the document is, which table/section to target, rows to include or skip.",
        ),
      pages: z
        .string()
        .optional()
        .describe(
          "PDF page selection, 1-based, e.g. '2-9' or '1,4-6'. Omit for the whole document.",
        ),
    }),
    execute: async (
      { file_path, schema, shape, instructions, pages },
      options,
    ) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          error:
            "extract is only available inside a conversation. No conversationId in the current context.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      const prepared = prepareExtractionSchema(schema, shape);
      if ("error" in prepared) {
        return {
          error: prepared.error,
          code: TOOL_ERROR_CODES.INVALID_SCHEMA,
          hint: 'Minimal valid schema: {"type":"object","properties":{"field_name":{"type":"string","description":"where the value appears"}}}. An empty {} is not a schema — declare at least one property.',
        };
      }

      const resolved = resolveWorkspacePath(file_path);
      if (!resolved) {
        return {
          error: `Path is outside the conversation's sandbox (/workspace/).`,
          code: TOOL_ERROR_CODES.PATH_OUT_OF_SANDBOX,
        };
      }

      const ext = getExtension(resolved.relative);
      if (SPREADSHEET_EXTENSIONS.has(ext)) {
        return {
          error: `Spreadsheet/CSV files parse deterministically — use python (pandas.read_excel / read_csv on '${resolved.absolute}') instead of a model extraction.`,
          code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
          hint: "python",
        };
      }
      const imageMime = IMAGE_MIMES[ext];
      const isPdf = ext === PDF_EXTENSION;
      const isOffice = OFFICE_EXTENSIONS.has(ext);
      if (!isPdf && !isOffice && imageMime === undefined) {
        return {
          error: `Not an extractable document format (${ext || "no extension"}). extract accepts .pdf, .docx, .pptx, .png, .jpg, .jpeg, .webp. For plain text or CSV, read/python already have the content.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
        };
      }

      if (pages !== undefined && !isPdf) {
        return {
          error: `"pages" only applies to PDFs — ${ext} documents are extracted whole.`,
          code: TOOL_ERROR_CODES.INVALID_PAGE_RANGE,
        };
      }

      let source: ExtractSource;
      const lateNotices: string[] = [];

      if (isOffice) {
        // Office docs have no native path on the extraction model —
        // they ride the cached OCR markdown (same content-addressed
        // extraction `read` uses; usually already warm).
        const name = basename(resolved.relative);
        const row = await db.query.aiChatFiles.findFirst({
          where: { conversationId, filename: name },
          columns: { id: true, fileHash: true, mimeType: true, size: true },
        });
        if (!row) {
          return {
            error: `File not found in this conversation's attachments: ${resolved.absolute}. For Drive documents, downloadDriveDocument first, then read.`,
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
          { metadata: { filename: name }, tags: ["process:extract-tool"] },
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
        source = {
          kind: "text",
          pages: extraction.pages.map((page) => ({
            pageNumber: page.index + 1,
            markdown: page.markdown,
          })),
          pagesTotal: extraction.pageCount ?? extraction.pages.length,
        };
      } else {
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

        if (imageMime !== undefined) {
          if (bytes.length > NATIVE_FILE_MAX_BYTES) {
            return {
              error: `Image exceeds the ${Math.round(NATIVE_FILE_MAX_BYTES / 1_000_000)}MB extraction limit — downscale it with python first.`,
              code: TOOL_ERROR_CODES.EXTRACT_ERROR,
            };
          }
          source = {
            kind: "image",
            bytes,
            mimeType: imageMime,
            filename: basename(resolved.relative),
          };
        } else {
          const pagesTotal = await getPdfPageCount(bytes);
          const splittable = pagesTotal !== null;
          let selectedPages: number[] = [];
          if (splittable) {
            if (pages !== undefined) {
              const selection = parsePageSelection(pages, pagesTotal);
              if ("error" in selection) {
                return {
                  error: selection.error,
                  code: TOOL_ERROR_CODES.INVALID_PAGE_RANGE,
                };
              }
              selectedPages = selection;
            } else {
              selectedPages = Array.from(
                { length: pagesTotal },
                (_, index) => index + 1,
              );
            }
          } else {
            if (bytes.length > NATIVE_FILE_MAX_BYTES) {
              return {
                error: `This PDF cannot be split (encrypted or non-standard) and exceeds the ${Math.round(NATIVE_FILE_MAX_BYTES / 1_000_000)}MB single-call limit. Use read for its text instead.`,
                code: TOOL_ERROR_CODES.EXTRACT_ERROR,
              };
            }
            if (pages !== undefined) {
              lateNotices.push(
                "This PDF could not be split into pages (encrypted or non-standard structure) — the whole document was extracted instead of the requested range.",
              );
            }
          }
          source = {
            kind: "pdf",
            bytes,
            filename: basename(resolved.relative),
            selectedPages,
            pagesTotal,
            splittable,
          };
        }
      }

      try {
        const result = await runStructuredExtract({
          source,
          prepared,
          shape,
          instructions,
        });
        return {
          filePath: resolved.absolute,
          ...result,
          notices: [...lateNotices, ...result.notices],
        };
      } catch (err) {
        return {
          error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.EXTRACT_ERROR,
        };
      }
    },
  });
