import { tool } from "ai";
import { basename } from "node:path";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  readFile,
  resolveWorkspacePath,
} from "../lib/conversation-storage";
import { NATIVE_FILE_MAX_BYTES } from "../lib/model-registry/types";
import { getPdfPageCount, parsePageSelection } from "../lib/pdf-pages";
import {
  buildExtractionSchema,
  type ExtractField,
  type ExtractSource,
  runStructuredExtract,
} from "../lib/structured-extract";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { withTraceSession } from "../lib/trace-tool";

/**
 * `extract` tool — schema-validated structured extraction from a NATIVE
 * document (PDF or image) in the conversation's workspace. The agent names a
 * FLAT list of fields; the server builds the JSON Schema and a file-capable
 * model (`lib/structured-extract.ts`) reads the file natively and returns
 * validated JSON. The agent never authors JSON Schema — the old `schema`
 * parameter (and the malformed-`{}` failure it caused) is gone.
 *
 * Native input only: Office/text documents are already text — the main model
 * reads them inline via `read`; spreadsheets/CSV go through `python` (pandas).
 */

const PDF_EXTENSION = ".pdf";
const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".pptx", ".ppt"]);

const getExtension = (path: string): string => {
  const dotIndex = path.lastIndexOf(".");
  return dotIndex > 0 ? path.slice(dotIndex).toLowerCase() : "";
};

const EXAMPLE_CALL =
  '{"file_path":"attachments/doc.pdf","shape":"records","fields":[{"name":"article_number","type":"integer","description":"the Art. N° column"},{"name":"description"},{"name":"net_weight_kg","type":"number"}]}';

/** Accept a legacy `schema` object (top-level `properties`) by converting it to
 * a flat field list — a one-release compat shim so a stale prompt doesn't fail. */
const fieldsFromLegacySchema = (schema: unknown): ExtractField[] | null => {
  if (typeof schema !== "object" || schema === null) return null;
  const props = (schema as Record<string, unknown>)["properties"];
  if (typeof props !== "object" || props === null) return null;
  const fields: ExtractField[] = [];
  for (const [name, def] of Object.entries(props as Record<string, unknown>)) {
    if (typeof def === "object" && def !== null) {
      const d = def as Record<string, unknown>;
      const rawType = d["type"];
      const type =
        rawType === "number" || rawType === "integer" || rawType === "boolean"
          ? rawType
          : "string";
      const description =
        typeof d["description"] === "string" ? d["description"] : undefined;
      fields.push({ name, type, description });
    } else {
      fields.push({ name });
    }
  }
  return fields.length > 0 ? fields : null;
};

export const createExtractTool = () =>
  tool({
    description: [
      "Extracts structured data from a NATIVE document (PDF or image) into schema-validated JSON — a file-capable model reads the file with its layout intact and returns exactly the fields you name.",
      "",
      "Use extract whenever the goal is DATA from a PDF or image (line items, table rows, header fields, named values), whatever the layout — never write a parsing script against a document's layout. Text you can already read (a .txt, an Office doc's text, a CSV) is NOT for extract: read it, or use python (pandas) for spreadsheets.",
      "",
      "Inputs:",
      "- file_path: ONE .pdf/.png/.jpg/.webp under `/workspace/`. One call per file — call extract in parallel for several files.",
      '- fields: a flat list of the fields to pull, each `{name, type?, description?}`. Give every numeric/date field its type (number|integer|boolean|date; default string) — typed values are validated server-side, untyped strings are not. Put guidance in `description` (where the value appears, units, exact format). Absent values come back null, never invented. Example: [{"name":"total","type":"number","description":"invoice grand total"},{"name":"issued","type":"date"}].',
      "- shape: 'records' → a LIST, one object per row/occurrence. 'record' → ONE object (header/summary fields). Header + line items = two calls (one 'record', one 'records').",
      "- instructions (optional): what the document is, which table/section to target, rows to skip, and — if the document repeats records across copies — to return each distinct record once.",
      "- pages (optional): 1-based selection like '2-9' or '1,4-6'. Omit for the whole document.",
      "",
      "Output: { pagesTotal, pagesCovered, complete, notices, data }. Check `complete`; when false, `notices` says exactly what to do. Data is already validated — aggregate it with `python` if needed, never re-extract the same values another way.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .min(1)
        .describe(
          "Workspace-relative or absolute path under '/workspace/' to ONE .pdf/.png/.jpg/.webp (e.g. 'attachments/invoice.pdf').",
        ),
      fields: z
        .array(
          z.object({
            name: z
              .string()
              .min(1)
              .max(80)
              .describe("Field name (snake_case), e.g. 'unit_price'."),
            type: z
              .enum(["string", "number", "integer", "boolean", "date"])
              .optional()
              .describe("Value type (default string). 'date' → ISO 8601."),
            description: z
              .string()
              .max(300)
              .optional()
              .describe(
                "Where the value appears, its units, and the exact output format.",
              ),
          }),
        )
        .min(1)
        .max(60)
        .optional()
        .describe(
          'The fields to extract, each {name, type?, description?}. Example: [{"name":"article_number","type":"integer"},{"name":"description"},{"name":"amount","type":"number","description":"line total in EUR"}].',
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
          "Extraction context: what the document is, which table/section to target, rows to include or skip, dedup rule for repeated copies.",
        ),
      pages: z
        .string()
        .optional()
        .describe(
          "PDF page selection, 1-based, e.g. '2-9' or '1,4-6'. Omit for the whole document.",
        ),
      // Deprecated legacy escape hatch — a raw JSON Schema. Undocumented in the
      // description; converted to `fields` for one release, then removed.
      schema: z.record(z.string(), z.unknown()).optional(),
    }),
    execute: async (
      { file_path, fields, shape, instructions, pages, schema },
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

      const warnings: string[] = [];
      let effectiveFields: ExtractField[] | undefined = fields;
      if ((!effectiveFields || effectiveFields.length === 0) && schema) {
        const legacy = fieldsFromLegacySchema(schema);
        if (legacy) {
          effectiveFields = legacy;
          warnings.push(
            "`schema` is deprecated — pass a flat `fields` list instead.",
          );
        }
      }
      if (!effectiveFields || effectiveFields.length === 0) {
        return {
          error:
            "extract needs a `fields` list — name the fields to pull from the document.",
          code: TOOL_ERROR_CODES.INVALID_ARGS,
          hint: `Example call: ${EXAMPLE_CALL}`,
        };
      }

      const prepared = buildExtractionSchema(effectiveFields, shape);
      if ("error" in prepared) {
        return {
          error: prepared.error,
          code: TOOL_ERROR_CODES.INVALID_ARGS,
          hint: `Example call: ${EXAMPLE_CALL}`,
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
          error: `Spreadsheet/CSV files parse deterministically — use python (pandas.read_excel / read_csv on '${resolved.absolute}') instead of extract.`,
          code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
          hint: "python",
        };
      }
      if (OFFICE_EXTENSIONS.has(ext)) {
        return {
          error: `extract is for native PDF/images. An Office document is already text — read it (the main model extracts fields directly from the text), or convert it to PDF first.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
          hint: "read",
        };
      }
      const imageMime = IMAGE_MIMES[ext];
      const isPdf = ext === PDF_EXTENSION;
      if (!isPdf && imageMime === undefined) {
        return {
          error: `Not a native document for extract (${ext || "no extension"}). extract accepts .pdf, .png, .jpg, .jpeg, .webp. For text or CSV, read/python already have the content.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
        };
      }
      if (pages !== undefined && !isPdf) {
        return {
          error: `"pages" only applies to PDFs — images are extracted whole.`,
          code: TOOL_ERROR_CODES.INVALID_PAGE_RANGE,
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

      let source: ExtractSource;
      const lateNotices: string[] = [];
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

      try {
        const result = await withTraceSession(
          conversationId,
          { tags: ["process:extract-tool"] },
          () => runStructuredExtract({ source, prepared, shape, instructions }),
        );
        return {
          filePath: resolved.absolute,
          ...result,
          notices: [...warnings, ...lateNotices, ...result.notices],
        };
      } catch (err) {
        return {
          error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.EXTRACT_ERROR,
        };
      }
    },
  });
