import {
  extensionOf,
  FILE_TYPES,
  typeForExtension,
} from "@fretik/shared/file-types";
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
import { persistToolResult } from "../lib/persisted-output";
import {
  buildExtractionSchema,
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

/**
 * Types a file-capable model ingests NATIVELY — the registry ids behind
 * `nativeInput.fileMimeTypes` (PDF) and the image modality. This is a
 * limit of the extraction MODEL, not of OCR: office and OpenDocument
 * files are excluded here because `read` already returns their text
 * (its OCR route handles them), so a second native call buys nothing.
 */
const NATIVE_EXTRACT_IDS = new Set(["pdf", "png", "jpeg", "webp"]);

const nativeExtractExtensions = (): string[] =>
  FILE_TYPES.filter((def) => NATIVE_EXTRACT_IDS.has(def.id)).flatMap((def) => [
    ...def.extensions,
  ]);

/** Above this serialized size the records stay in the file only — the model
 * works from `dataPath` with `python` instead of reading them inline. */
const EXTRACT_INLINE_MAX_CHARS = 15_000;
/** Rows kept inline as a shape sample when the full set is omitted. */
const EXTRACT_PREVIEW_RECORDS = 3;

const EXAMPLE_CALL =
  '{"file_path":"attachments/doc.pdf","shape":"records","fields":[{"name":"article_number","type":"integer","description":"the Art. N° column"},{"name":"description"},{"name":"net_weight_kg","type":"number"}]}';

export const createExtractTool = () =>
  tool({
    description: [
      "Extracts structured data from a NATIVE document (PDF or image) into schema-validated JSON — a file-capable model reads the file with its layout intact and returns exactly the fields you name.",
      "",
      "Use extract whenever the goal is DATA from a PDF or image (line items, table rows, header fields, named values), whatever the layout — never write a parsing script against a document's layout. Text you can already read (a .txt, an Office doc's text, a CSV) is NOT for extract: read it, or use python (pandas) for spreadsheets.",
      "",
      "You must know WHAT a file is before naming its fields. On a file you have not identified, `read` it first — one cheap call. A field set that does not match the document costs a full model pass and comes back empty or nonsense, so never try several field sets on the same file to see which fits, and never merge every document type into one wide schema.",
      "",
      "Inputs:",
      "- file_path: ONE .pdf/.png/.jpg/.webp under `/workspace/`. One call per file — call extract in parallel for several files.",
      '- fields: a flat list of the fields to pull, each `{name, type?, description?}`. Give every numeric/date field its type (number|integer|boolean|date; default string) — typed values are validated server-side, untyped strings are not. Put guidance in `description` (where the value appears, units, exact format). Absent values come back null, never invented. Example: [{"name":"total","type":"number","description":"invoice grand total"},{"name":"issued","type":"date"}].',
      "- shape: 'records' → a LIST, one object per row/occurrence. 'record' → ONE object (header/summary fields). Header + line items = two calls (one 'record', one 'records').",
      "- instructions (optional): what the document is, which table/section to target, rows to skip, and — if the document repeats records across copies — to return each distinct record once.",
      "- pages (optional): 1-based selection like '2-9' or '1,4-6'. Omit it by default — the whole document is read, and a long one is sectioned server-side. Slicing a document into windows yourself returns the same rows several times on any document that repeats its content across copies.",
      "",
      "Output: { pagesCovered, recordsReturned, modelCountedTotal, complete, notices, dataPath, data }. `dataPath` is the validated records on disk: load it in `python` (`json.load(open(dataPath))['records']`) — NEVER retype values into code. Big results come back as `dataPreview` (3 rows) with `data` omitted; the file always holds everything. `complete` means no problem was detected, not that nothing was missed — `modelCountedTotal` is the extractor counting itself, so weigh `recordsReturned` against the document's size before building on it, and act on `notices`.",
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
          "PDF page selection, 1-based, e.g. '2-9' or '1,4-6'. Omit (or '') for the whole document — the default, and the right choice unless you need one known section.",
        ),
    }),
    execute: async (
      { file_path, fields, shape, instructions, pages },
      options,
    ) => {
      // An OPTIONAL string param comes back as "" from models that fill every
      // field of the schema — measured 13 of 38 prod calls, every one on the
      // first attempt of a run, all rejected by `parsePageSelection`. Blank and
      // "all" mean the same thing the parameter's absence means: whole document.
      const pageSpec = pages?.trim() ?? "";
      const pageSelection =
        pageSpec === "" || pageSpec.toLowerCase() === "all"
          ? undefined
          : pageSpec;

      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          error:
            "extract is only available inside a conversation. No conversationId in the current context.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      const prepared = buildExtractionSchema(fields, shape);
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

      const ext = extensionOf(resolved.relative);
      const def = typeForExtension(ext);
      const isNative = def !== undefined && NATIVE_EXTRACT_IDS.has(def.id);

      if (!isNative && def?.family === "spreadsheet") {
        return {
          error: `Spreadsheet/CSV files parse deterministically — use python (pandas.read_excel / read_csv on '${resolved.absolute}') instead of extract.`,
          code: TOOL_ERROR_CODES.BINARY_NOT_READABLE,
          hint: "python",
        };
      }
      if (
        !isNative &&
        (def?.extraction === "mistral-ocr" || def?.extraction === "convert-ocr")
      ) {
        return {
          error: `extract is for native PDF/images. An Office document is already text — read it (the main model extracts fields directly from the text), or convert it to PDF first.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
          hint: "read",
        };
      }
      if (!isNative || def === undefined) {
        return {
          error: `Not a native document for extract (${ext || "no extension"}). extract accepts ${nativeExtractExtensions().join(", ")}. For text or CSV, read/python already have the content.`,
          code: TOOL_ERROR_CODES.UNSUPPORTED_EXTENSION,
        };
      }
      const isPdf = def.id === "pdf";
      const imageMime = isPdf ? undefined : def.mime;
      if (pageSelection !== undefined && !isPdf) {
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
          if (pageSelection !== undefined) {
            const selection = parsePageSelection(pageSelection, pagesTotal);
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
          if (pageSelection !== undefined) {
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
        // The data is ALWAYS written out, whatever its size — that path is the
        // only thing standing between the model and re-typing every value into
        // a python literal (prod 2026-07-27: 28 rows × 17 fields hand-copied,
        // the run's biggest output-token line). Same directory as the
        // large-output envelopes, but the tool keeps its structured shape:
        // `complete` / `notices` / counts must stay readable as fields.
        const { data, ...envelope } = result;
        const persisted = await persistToolResult(
          data,
          conversationId,
          options.toolCallId,
        );
        const inline =
          persisted.totalChars <= EXTRACT_INLINE_MAX_CHARS
            ? { data }
            : {
                dataPreview:
                  "records" in data
                    ? data.records.slice(0, EXTRACT_PREVIEW_RECORDS)
                    : data.record,
                dataInlineOmitted: true,
              };
        return {
          filePath: resolved.absolute,
          ...envelope,
          notices: [...lateNotices, ...result.notices],
          dataPath: persisted.path,
          ...inline,
        };
      } catch (err) {
        return {
          error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.EXTRACT_ERROR,
        };
      }
    },
  });
