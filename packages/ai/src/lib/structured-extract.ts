import { type JSONSchema7 } from "@ai-sdk/provider";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { generateText } from "ai";
import { Ajv, type ValidateFunction } from "ajv";
import { describeLlmError } from "./describe-llm-error";
import { telemetryFor } from "./langfuse";
import { resolveModel } from "./model-registry/resolve";
import { resolveModelForTeam } from "./model-registry/team-model";
import { formatPageRanges, slicePdfPages } from "./pdf-pages";
import { SCHEMA_BLOCK_TRAILER } from "./schema-prompt";

/**
 * Structured-extraction engine behind the `extract` tool. NATIVE INPUT ONLY:
 * the agent names a flat list of fields; a file-capable model (registry role
 * `vision`, shared with the `vision` tool) reads the PDF or
 * image NATIVELY (OpenRouter `file-parser` plugin, `engine:"native"`, same route
 * as `lib/vision.ts`) and emits free-form JSON for the prompt-side schema. Text
 * sources (Office/OCR markdown, plain text, CSV) are NOT this engine's job —
 * the main chat model reads them inline via `read`, or `python` parses tabular
 * files.
 *
 * Replay-driven config (WS0 2026-07-24 on a 40-page customs DAE, then the
 * prod-shape replays of the same day):
 *   1. `temperature:0` returns EMPTY on Gemini 3.x — dropped entirely (the
 *      Vertex ZDR route omits `temperature` anyway; low temp also makes it loop).
 *   2. Reasoning tokens count against the output cap → 60K cap, and the effort
 *      is pinned to "low": "minimal" lets the model skip thinking and leak its
 *      chain-of-thought into string values, "medium" makes it plan everything
 *      in thought summaries and emit ONE record (both observed, repeatedly).
 *   3. **NO constrained decoding.** `Output.object` (`response_format:
 *      json_schema, strict:true`) makes Gemini bail BIMODALLY: ~half of calls
 *      emit ONE record then stop, with the chain-of-thought leaked into a
 *      string value — measured 0/4 constrained vs 7/7 free-form (28/28, text
 *      AND native PDF) on the exact prod failure. The schema rides in the
 *      system prompt; the model emits plain JSON; `parseExtractionEnvelope`
 *      parses it (fence/prose-tolerant, truncation salvage) and the per-record
 *      Ajv validator enforces the field types. Bonus: identical behaviour on
 *      providers that don't support `response_format` at all.
 * The old 8-page chunk ladder, halve-then-fallback recovery, OCR-text mode, and
 * the ~350-line JSON-Schema lowering/sanitising layer are all gone: the agent
 * hands a flat field list, the server BUILDS the (always-valid) JSON Schema, so
 * a malformed schema can no longer reach the model.
 *
 * Completeness — a single model call is NOT trustworthy (prod 2026-07-24: 1 of
 * 28 records with finish=stop, reported complete). Three guards, all
 * server-side: (a) a required `total_matching_records` count the model must
 * fill BEFORE emitting, verified against the array and driving bounded
 * continuations; (b) an Ajv-side string-length ceiling so leaked reasoning
 * drops the record instead of passing as data; (c) `complete:false` + an
 * agent-directive notice whenever a gap, a drop, or an empty result remains.
 */

/**
 * The team's extraction model, resolved PER CALL.
 *
 * It shares the `vision` function with the `vision` tool — one file-capable
 * model backs both — and it used to share the same defect: two module-level
 * constants captured at import, so a team's pick never applied and neither did
 * a quarantine written overnight.
 *
 * The FALLBACK stays on the code default, as everywhere: it is the redundancy.
 */
const extractModelsFor = async (teamId: string | undefined) => {
  const primary = await resolveModelForTeam("vision", teamId);
  const fallback = resolveModel("vision-fallback");
  return {
    primary: primary.model,
    primaryId: primary.profile.catalog.id,
    fallback: fallback.model,
    fallbackId: fallback.profile.catalog.id,
  };
};

type ExtractModels = Awaited<ReturnType<typeof extractModelsFor>>;

/** Whole-document single call up to this many pages; larger docs split into
 * `EXTRACT_SECTION_PAGES`-page sections (rare — most business docs are smaller). */
export const EXTRACT_WHOLE_DOC_MAX_PAGES = 50;
/** Section size when a document exceeds the whole-doc threshold. */
export const EXTRACT_SECTION_PAGES = 40;
/** Bounded parallelism across section calls. */
const EXTRACT_SECTION_CONCURRENCY = 2;
/** Max follow-up calls after a `length` truncation before reporting a gap. */
const EXTRACT_MAX_CONTINUATIONS = 3;
/** A `records` call covering more than this many pages… */
const EXTRACT_SPARSE_MIN_PAGES = 3;
/** …and returning no more than this many rows gets ONE extra independent
 * sample: the count assertion cannot detect a model that under-counts. */
const EXTRACT_SPARSE_MAX_ROWS = 3;

/** Reasoning counts against the output budget; Gemini mandates it, so pin the
 * least and give plenty of headroom (model max is 65 536). */
const EXTRACT_MAX_OUTPUT_TOKENS = 60_000;
// A normal whole-doc call is ~7-30s, but a LEGITIMATE dense-document call can
// need well over 90s: prod 2026-07-30 (workflow run 019fb3ab…) hit two back-to-
// back 90s timeouts on a chunk whose extraction emits ~14.7k output tokens —
// undoable in 90s at flash-lite throughput — before the fallback landed it in
// 58s. 180s clears that class of call while still bounding a stalled Vertex
// route (2026-07-24 replays: stochastic 120s+ hangs); on timeout we go straight
// to the fallback model — no same-model retry, which for an output-bound chunk
// just re-buys the identical timeout.
const EXTRACT_TIMEOUT_MS = 180_000;
// "low", not "minimal": minimal lets Gemini skip thinking entirely, and with
// thinking unengaged it leaks its chain-of-thought into string values and
// stops after 1 record (prod 2026-07-24 + replays: minimal 0/3, low 2/3 —
// the count-assertion continuation covers the remaining bail case). "medium"
// is WORSE (plans everything in thought summaries, emits 1 record, 0/3).
const EXTRACT_REASONING_EFFORT = "low" as const;

/** Bounds on the agent-supplied field list. */
const EXTRACT_MAX_FIELDS = 60;
const EXTRACT_FIELD_NAME_MAX = 80;
const EXTRACT_FIELD_DESC_MAX = 300;

export type ExtractShape = "records" | "record";

export type ExtractedRow = Record<string, unknown>;

/** Scalar field types the agent may name; `date` maps to an ISO-8601 string. */
export type ExtractFieldType =
  "string" | "number" | "integer" | "boolean" | "date";

const FIELD_TYPES: readonly ExtractFieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
];

/** One field the agent wants extracted — a bare name, or name + type + guidance. */
export type ExtractField =
  string | { name: string; type?: ExtractFieldType; description?: string };

/** Native document source — PDF (splittable into page ranges) or a single image. */
export type ExtractSource =
  | {
      kind: "pdf";
      bytes: Uint8Array;
      filename: string;
      /** Sorted 1-based pages to cover. Empty + `splittable:false` = whole doc. */
      selectedPages: number[];
      /** Total pages, `null` when the PDF could not be parsed locally. */
      pagesTotal: number | null;
      /** False when pdf-lib cannot re-assemble the doc (encrypted/corrupt). */
      splittable: boolean;
    }
  | { kind: "image"; bytes: Uint8Array; mimeType: string; filename: string };

export interface RunStructuredExtractArgs {
  /** Whose extraction model to use. Absent on paths with no team in scope. */
  teamId?: string;
  source: ExtractSource;
  /** Prepared via `buildExtractionSchema` (the tool builds it from `fields`). */
  prepared: PreparedExtractionSchema;
  shape: ExtractShape;
  instructions?: string;
}

export interface StructuredExtractResult {
  /** Model id(s) that produced the data ("primary" or "primary+fallback"). */
  model: string;
  pagesTotal: number | null;
  /** Compact 1-based range string actually covered ("1-29", "all"). */
  pagesCovered: string;
  /** Number of model calls made (1 for the common whole-doc case). */
  chunks: number;
  /** Rows actually returned (`records`) or 1/0 (`record`). */
  recordsReturned: number;
  /** What the extractor itself counted, summed over calls; `null` when it did
   * not report a count. Equal to `recordsReturned` proves self-consistency
   * only — NOT that the document held nothing more. */
  modelCountedTotal: number | null;
  /** False when a section/continuation failed or a truncation gap remains. */
  complete: boolean;
  /** Agent-directive follow-up guidance (which pages to re-call, and how). */
  notices: string[];
  data: { records: ExtractedRow[] } | { record: ExtractedRow };
}

interface SchemaError {
  error: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSchemaError = (value: unknown): value is SchemaError =>
  isPlainObject(value) && typeof value["error"] === "string";

// ============================================================================
// Schema build (flat fields → wrapped JSONSchema7 + Ajv validator)
// ============================================================================

interface NormalizedField {
  name: string;
  type: ExtractFieldType;
  description?: string;
}

/** A flat field entry → `{name,type,description}`, trimmed and bounded. Rejects
 * empties, duplicates and over-long names so the built schema is always valid. */
const normalizeFields = (
  fields: readonly ExtractField[],
): NormalizedField[] | SchemaError => {
  if (!Array.isArray(fields) || fields.length === 0) {
    return { error: "`fields` must be a non-empty array." };
  }
  if (fields.length > EXTRACT_MAX_FIELDS) {
    return {
      error: `Too many fields (${fields.length} > ${EXTRACT_MAX_FIELDS}) — trim the list, or extract in several calls.`,
    };
  }
  const out: NormalizedField[] = [];
  const seen = new Set<string>();
  for (const raw of fields) {
    let name: string;
    let type: ExtractFieldType = "string";
    let description: string | undefined;
    if (typeof raw === "string") {
      name = raw.trim();
    } else if (isPlainObject(raw) && typeof raw["name"] === "string") {
      name = raw["name"].trim();
      const t = raw["type"];
      if (typeof t === "string") {
        if (!FIELD_TYPES.includes(t as ExtractFieldType)) {
          return {
            error: `Field "${name}" has an unknown type "${t}" — use one of: ${FIELD_TYPES.join(", ")}.`,
          };
        }
        type = t as ExtractFieldType;
      }
      const d = raw["description"];
      if (typeof d === "string" && d.trim()) {
        description = d.trim().slice(0, EXTRACT_FIELD_DESC_MAX);
      }
    } else {
      return {
        error:
          'Each field is a name string or {name, type?, description?}. Example: {"name":"total","type":"number","description":"invoice total"}.',
      };
    }
    if (!name) return { error: "A field name is empty." };
    if (name.length > EXTRACT_FIELD_NAME_MAX) {
      return { error: `Field name too long: "${name.slice(0, 30)}…".` };
    }
    if (seen.has(name)) continue; // tolerate a repeated field name
    seen.add(name);
    out.push({ name, type, description });
  }
  if (out.length === 0) return { error: "No usable fields." };
  return out;
};

/** Ceiling on one extracted string value. NOT sent to the provider (Vertex
 * structured output may reject unknown keywords) — enforced by the Ajv record
 * validator only, so a model that rambles its chain-of-thought INSIDE a string
 * value (observed in prod: full CoT leaked into one field, 2026-07-24) drops
 * that record with a notice instead of returning schema-valid garbage. */
const EXTRACT_STRING_VALUE_MAX = 1000;

/** Server-injected envelope field for `shape:"records"` — the model counts the
 * matching occurrences BEFORE emitting them, giving the engine a completeness
 * assertion (`records.length` vs the count). Never visible in the agent's
 * `fields`, never returned in `data`. */
const TOTAL_COUNT_FIELD = "total_matching_records";

/** JSONSchema7 leaf for one field. `date` → string with an ISO hint; every leaf
 * admits null so an absent value comes back null instead of invented. With
 * `forValidation`, string leafs get the value-length ceiling (Ajv-side only). */
const fieldToLeaf = (
  field: NormalizedField,
  forValidation = false,
): JSONSchema7 => {
  const baseType: "string" | "number" | "integer" | "boolean" =
    field.type === "date" ? "string" : field.type;
  const description =
    field.type === "date"
      ? `${field.description ? `${field.description}. ` : ""}Date as ISO 8601 (YYYY-MM-DD) or the format the instructions request.`
      : field.description;
  const leaf: JSONSchema7 = { type: [baseType, "null"] };
  if (forValidation && baseType === "string") {
    leaf.maxLength = EXTRACT_STRING_VALUE_MAX;
  }
  if (description) leaf.description = description;
  return leaf;
};

interface ExtractLlmEnvelope {
  records?: ExtractedRow[];
  record?: ExtractedRow;
  /** The model's own count of matching occurrences (records shape only). */
  reportedTotal?: number;
}

export interface PreparedExtractionSchema {
  /** Full wrapped schema embedded in the system prompt (the only channel —
   * constrained decoding is deliberately NOT used, see the file header). */
  wrapped: JSONSchema7;
  /** Pretty-printed `wrapped` for the system-prompt `<schema>` block. */
  promptSchema: string;
  /** Per-record Ajv validator (coerces types); drops invalid rows, never throws. */
  validateRecord: ValidateFunction;
}

// `coerceTypes` normalises a stray "12.5" string into a number rather than
// dropping the record; `removeAdditional` strips keys the model invented.
const ajv = new Ajv({
  strict: false,
  validateFormats: false,
  allErrors: false,
  coerceTypes: true,
  useDefaults: false,
  removeAdditional: true,
});

/**
 * Free-form model text → extraction envelope. JSON parsing (fence/prose
 * tolerance, truncation salvage) is the shared `parseLlmJsonObject`; this adds
 * only the extract-specific structural read: keep a `records` array / `record`
 * object, surface the model's own count. Per-field validation is deferred to
 * `validateRecord` so one bad value can't reject the whole extraction.
 */
export const parseExtractionEnvelope = (
  text: string,
  options: { salvageTruncation?: boolean } = {},
): ExtractLlmEnvelope | null => {
  const value = parseLlmJsonObject(text, options);
  if (!isPlainObject(value)) return null;
  const envelope: ExtractLlmEnvelope = {};
  const records = value["records"];
  if (Array.isArray(records)) envelope.records = records.filter(isPlainObject);
  const record = value["record"];
  if (isPlainObject(record)) envelope.record = record;
  const total = value[TOTAL_COUNT_FIELD];
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    envelope.reportedTotal = Math.floor(total);
  }
  return envelope;
};

/**
 * Build the wrapped extraction schema from a flat field list. The server owns
 * every structural decision (nesting, nullability, the `{records}`/`{record}`
 * envelope), so the agent never authors JSON Schema and the result is always
 * valid — the old INVALID_SCHEMA failure class is gone. Returns a SchemaError
 * only for an empty/oversized field list.
 */
export const buildExtractionSchema = (
  fields: readonly ExtractField[],
  shape: ExtractShape,
): PreparedExtractionSchema | SchemaError => {
  const normalized = normalizeFields(fields);
  if (isSchemaError(normalized)) return normalized;

  const properties: Record<string, JSONSchema7> = {};
  for (const field of normalized) properties[field.name] = fieldToLeaf(field);
  const record: JSONSchema7 = {
    type: "object",
    properties,
    additionalProperties: false,
  };

  // `total_matching_records` FIRST: the model must count before it emits, which
  // gives the engine a completeness assertion to verify the array against.
  const wrapped: JSONSchema7 =
    shape === "records"
      ? {
          type: "object",
          properties: {
            [TOTAL_COUNT_FIELD]: {
              type: "integer",
              description:
                "Total count of occurrences matching the request in the visible content. Count them FIRST; `records` must then contain exactly this many entries.",
            },
            records: { type: "array", items: record },
          },
          required: [TOTAL_COUNT_FIELD, "records"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: { record },
          required: ["record"],
          additionalProperties: false,
        };

  // Validation twin of `record` with the string-length ceiling — Ajv-side only,
  // never sent to the provider.
  const validationProperties: Record<string, JSONSchema7> = {};
  for (const field of normalized) {
    validationProperties[field.name] = fieldToLeaf(field, true);
  }
  let validateRecord: ValidateFunction;
  try {
    validateRecord = ajv.compile({
      type: "object",
      properties: validationProperties,
      additionalProperties: false,
    } satisfies JSONSchema7);
  } catch (compileError) {
    return {
      error: `Could not compile the field schema: ${compileError instanceof Error ? compileError.message : String(compileError)}`,
    };
  }

  return {
    wrapped,
    promptSchema: JSON.stringify(wrapped, null, 2),
    validateRecord,
  };
};

/** Keep only records that satisfy the per-field schema (types coerced in place);
 * returns kept rows + how many were dropped as unrepairable. */
const validateRecords = (
  rows: readonly ExtractedRow[],
  validate: ValidateFunction,
): { kept: ExtractedRow[]; dropped: number } => {
  const kept: ExtractedRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    const candidate = { ...row };
    if (validate(candidate)) kept.push(candidate);
    else dropped += 1;
  }
  return { kept, dropped };
};

/** Stable identity of a record for dedup — sorted key/value JSON. */
/**
 * Identity of a record for deduplication ACROSS independent samples, so a
 * re-sample of the same document does not double the row count.
 *
 * Raw JSON equality is too strict: a re-sample re-transcribes free text, and
 * one differing space, accent or trailing period made the row "new" — prod
 * 2026-07-27 returned 50 rows for a 28-article document, reported complete.
 * Normalising strings (case, accents, whitespace, punctuation-ish edges) and
 * numbers (trailing-zero noise) makes the key stable under re-transcription
 * while still separating genuinely different records.
 */
const normaliseKeyValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  if (typeof value === "number") return Number(value.toPrecision(10));
  return value;
};

export const recordKey = (row: ExtractedRow): string => {
  const keys = Object.keys(row).sort();
  return JSON.stringify(keys.map((k) => [k, normaliseKeyValue(row[k])]));
};

// ============================================================================
// Page planning
// ============================================================================

/** Split a sorted page list into fixed sections (only used beyond the whole-doc
 * threshold). */
export const planSections = (
  pages: readonly number[],
  sectionSize: number = EXTRACT_SECTION_PAGES,
): number[][] => {
  const sections: number[][] = [];
  for (let i = 0; i < pages.length; i += sectionSize) {
    sections.push([...pages.slice(i, i + sectionSize)]);
  }
  return sections;
};

// ============================================================================
// LLM calls
// ============================================================================

const EXTRACT_SYSTEM_PROMPT = `You are a precise document-data extractor.

Rules:
- Extract ONLY values visible in the document. Never infer, compute, or invent a value.
- A field whose value is absent or unreadable is null — never guess, never substitute a nearby value.
- Copy numbers and dates exactly as printed (dates reformatted to the requested format; decimal commas become decimal points: 12,5 → 12.5; currency symbols and thousands separators excluded from numbers).
- For a "records" array, emit one record per occurrence (table row, line item, repeated block) in document order. If the task instructions say the document repeats the same records (administrative copies, duplicated pages), emit each distinct record ONCE.
- When the schema asks for "total_matching_records": COUNT every matching occurrence in the visible content first, set that field, then emit the records — the array length MUST equal your count. Never stop after a partial list.
- You may be shown a page subset of a larger document — extract from the pages you see, nothing else.
- Field descriptions in the schema are authoritative instructions.`;

interface CallContext {
  prepared: PreparedExtractionSchema;
  shape: ExtractShape;
  instructions?: string;
  pagesTotal: number | null;
  /** Resolved once per extract run and carried, not re-resolved per page. */
  models: ExtractModels;
}

interface CallFile {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}

interface LlmCallResult {
  rows: ExtractedRow[];
  singleRecord: ExtractedRow | null;
  truncated: boolean;
  /** The model's own occurrence count (records shape), null when absent. */
  reportedTotal: number | null;
}

const buildCoverageNote = (
  ctx: CallContext,
  pages: readonly number[],
): string => {
  if (pages.length === 0 || ctx.pagesTotal === null) {
    return "You are seeing the full document.";
  }
  return `The document has ${ctx.pagesTotal} page${ctx.pagesTotal === 1 ? "" : "s"}. You are seeing page${pages.length === 1 ? "" : "s"} ${formatPageRanges(pages)} of it. Extract only from these pages.`;
};

const buildCallText = (
  ctx: CallContext,
  pages: readonly number[],
  seenKeys: readonly string[],
  knownTotal: number | null,
): string => {
  const parts = [buildCoverageNote(ctx, pages)];
  if (ctx.instructions) parts.push(ctx.instructions);
  if (seenKeys.length > 0) {
    const ofTotal =
      knownTotal !== null ? ` of the ${knownTotal} you counted` : "";
    parts.push(
      `You already extracted ${seenKeys.length} record(s)${ofTotal}. Continue: extract ONLY the records you have not returned yet. Do not repeat any already-extracted record.`,
    );
  }
  parts.push(
    ctx.shape === "records"
      ? "Extract every matching record from the visible content now."
      : "Extract the requested field values from the visible content now.",
  );
  return parts.join("\n\n");
};

const buildSystemPrompt = (ctx: CallContext): string =>
  `${EXTRACT_SYSTEM_PROMPT}

<schema>
${ctx.prepared.promptSchema}
</schema>

${SCHEMA_BLOCK_TRAILER}`;

/** One FREE-FORM call over a native file — no `response_format`/constrained
 * decoding (bimodal 1-record bail, see file header), thinking pinned to low,
 * NO temperature (all load-bearing). The schema constrains via the system
 * prompt; the response text is parsed with the shared LLM-JSON parser. */
const callExtractLlm = async (
  model: ExtractModels["primary"],
  ctx: CallContext,
  pages: readonly number[],
  file: CallFile,
  seenKeys: readonly string[],
  knownTotal: number | null = null,
): Promise<LlmCallResult> => {
  const { text, finishReason } = await generateText({
    model,
    system: buildSystemPrompt(ctx),
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    telemetry: telemetryFor("extract"),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: file.bytes,
            mediaType: file.mediaType,
            filename: file.filename,
          },
          {
            type: "text",
            text: buildCallText(ctx, pages, seenKeys, knownTotal),
          },
        ],
      },
    ],
    providerOptions: {
      openrouter: {
        // Mandatory Gemini reasoning pinned low (it counts against the output
        // cap); native-PDF route bypasses OpenRouter's Mistral-OCR default.
        reasoning: { effort: EXTRACT_REASONING_EFFORT },
        plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
      },
    },
  });
  const truncated = finishReason === "length";
  const envelope = parseExtractionEnvelope(text, {
    salvageTruncation: truncated,
  });
  if (envelope === null) {
    // Unparsable output is a failed call — the caller's retry/fallback and
    // re-sample paths handle it like any other model error.
    throw new Error(
      `extraction output was not parseable JSON (finishReason: ${finishReason}, ${text.length} chars)`,
    );
  }
  return {
    rows: envelope.records ?? [],
    singleRecord: envelope.record ?? null,
    truncated,
    reportedTotal: envelope.reportedTotal ?? null,
  };
};

interface SectionOutcome {
  pages: number[];
  rows: ExtractedRow[];
  singleRecord: ExtractedRow | null;
  truncated: boolean;
  /** The model's own occurrence count for this call's visible content. */
  reportedTotal: number | null;
  failed: boolean;
  usedFallback: boolean;
  dropped: number;
  error?: string;
  unavailable?: boolean;
}

/**
 * Does this result look like Gemini's bimodal bail — a handful of rows spread
 * over many pages — and so deserve an independent second draw?
 *
 * Structural on purpose. The model's own `total_matching_records` is NOT part
 * of it: on one 5-page invoice it reported 26, then 31, then 1, for 21 real
 * lines. Driving a full re-extraction from that number cost ~70s per call and
 * returned 42 rows for 21 (prod 2026-07-29).
 */
export const isSparseResult = (
  rowCount: number,
  pageCount: number,
  shape: ExtractShape,
): boolean =>
  shape === "records" &&
  pageCount > EXTRACT_SPARSE_MIN_PAGES &&
  rowCount >= 1 &&
  rowCount <= EXTRACT_SPARSE_MAX_ROWS;

/**
 * Run one native call (whole doc or one section) with continuation on
 * truncation and a single fallback-model retry on error. `file` already carries
 * the right bytes (the whole doc, or a sliced section).
 */
const runNativeCall = async (
  ctx: CallContext,
  pages: number[],
  file: CallFile,
): Promise<SectionOutcome> => {
  let collected: ExtractedRow[] = [];
  const seen = new Set<string>();
  let singleRecord: ExtractedRow | null = null;
  let usedFallback = false;
  let dropped = 0;

  /** Validated rows of ONE call, de-duplicated within that call only. */
  const validateSample = (result: LlmCallResult): ExtractedRow[] => {
    const validated = validateRecords(result.rows, ctx.prepared.validateRecord);
    dropped += validated.dropped;
    const rows: ExtractedRow[] = [];
    const keys = new Set<string>();
    for (const row of validated.kept) {
      const key = recordKey(row);
      if (keys.has(key)) continue;
      keys.add(key);
      rows.push(row);
    }
    return rows;
  };

  const takeSingleRecord = (result: LlmCallResult): void => {
    if (result.singleRecord && !singleRecord) {
      const candidate = { ...result.singleRecord };
      if (ctx.prepared.validateRecord(candidate)) singleRecord = candidate;
      else dropped += 1;
    }
  };

  /** Union into `collected` — ONLY for truncation continuations, where the
   *  pieces are genuinely disjoint parts of one interrupted answer. */
  const absorb = (result: LlmCallResult): void => {
    for (const row of validateSample(result)) {
      const key = recordKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(row);
    }
    takeSingleRecord(result);
  };

  let result: LlmCallResult;
  try {
    result = await callExtractLlm(ctx.models.primary, ctx, pages, file, []);
  } catch (primaryError) {
    console.warn(
      `[extract] ${describeRange(pages)} failed on ${ctx.models.primaryId}, retrying on ${ctx.models.fallbackId} — ${describeLlmError(primaryError)}`,
    );
    try {
      result = await callExtractLlm(ctx.models.fallback, ctx, pages, file, []);
      usedFallback = true;
    } catch (fallbackError) {
      console.error(
        `[extract] ${describeRange(pages)} failed on both models — ${describeLlmError(fallbackError)}`,
      );
      const failure = summariseExtractFailure(fallbackError);
      return {
        pages,
        rows: [],
        singleRecord: null,
        truncated: false,
        reportedTotal: null,
        failed: true,
        usedFallback: true,
        dropped: 0,
        error: failure.reason,
        unavailable: failure.unavailable,
      };
    }
  }
  absorb(result);

  // Recovery, on a "records" extraction. TWO paths, and they compose data in
  // OPPOSITE ways — which is the whole point.
  //
  //   • TRUNCATION (finishReason=length): the array was genuinely cut off, so
  //     the pieces are disjoint parts of one answer → continue FROM what we
  //     have (seed with seenKeys) and UNION.
  //
  //   • SPARSE RESULT (a handful of rows spread over many pages): Gemini's
  //     bimodal bail — it emits 1 record and stops even though the document
  //     holds 28 (proven 2026-07-24, ~half of attempts, independent of page
  //     count). The answer is a FRESH independent draw — no seedKeys, which
  //     re-triggers the bail — and the draws then COMPETE: keep the fullest,
  //     never the union. Two independent transcriptions of the same table are
  //     not two halves of it; unioning them doubles every row whose free-text
  //     field the model re-worded. Prod 2026-07-29: 42 rows returned for a
  //     21-line invoice, 114s instead of 45s, and the executor spent python
  //     calls undoing it.
  //
  // The model's own `total_matching_records` triggers NOTHING any more. On one
  // 5-page invoice it reported 26, then 31, then 1 — for 21 real lines. It is
  // reported in the envelope and flagged when it disagrees, nothing else.
  let truncated = result.truncated && ctx.shape === "records";
  let reportedTotal = result.reportedTotal;
  let rounds = 0;
  while (truncated && rounds < EXTRACT_MAX_CONTINUATIONS) {
    rounds += 1;
    const before = collected.length;
    try {
      const cont = await callExtractLlm(
        ctx.models.primary,
        ctx,
        pages,
        file,
        [...seen],
        reportedTotal,
      );
      absorb(cont);
      truncated = cont.truncated;
      if (reportedTotal === null) reportedTotal = cont.reportedTotal;
    } catch (contError) {
      // A transient stall shouldn't end the recovery; a hard error (bad
      // request, auth) won't fix itself.
      console.warn(
        `[extract] continuation ${rounds.toString()} failed — ${describeLlmError(contError)}`,
      );
      if (!isTimeoutError(contError)) break;
      continue;
    }
    // A continuation that adds nothing is exhausted.
    if (collected.length === before) break;
  }

  while (
    isSparseResult(collected.length, pages.length, ctx.shape) &&
    rounds < EXTRACT_MAX_CONTINUATIONS
  ) {
    rounds += 1;
    let sample: LlmCallResult;
    try {
      sample = await callExtractLlm(
        ctx.models.primary,
        ctx,
        pages,
        file,
        [],
        reportedTotal,
      );
    } catch (probeError) {
      console.warn(
        `[extract] re-sample ${rounds.toString()} failed — ${describeLlmError(probeError)}`,
      );
      if (!isTimeoutError(probeError)) break;
      continue;
    }
    takeSingleRecord(sample);
    if (reportedTotal === null) reportedTotal = sample.reportedTotal;
    const rows = validateSample(sample);
    // No improvement means the document really is this sparse — stop rather
    // than pay for a third opinion.
    if (rows.length <= collected.length) break;
    collected = rows;
  }

  return {
    pages,
    rows: collected,
    singleRecord,
    truncated,
    reportedTotal,
    failed: false,
    usedFallback,
    dropped,
  };
};

// ============================================================================
// Result assembly + entry point
// ============================================================================

const describeRange = (pages: readonly number[]): string =>
  pages.length === 0 ? "the document" : `pages ${formatPageRanges(pages)}`;

/** A stalled call (AbortSignal.timeout fired, or transport timeout). */
const isTimeoutError = (err: unknown): boolean => {
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /timed? ?out|aborted/i.test(message);
};

/**
 * Compact, agent-facing summary of a call that failed on BOTH models.
 * `unavailable` marks failures a same-call retry can't fix — provider routing /
 * data-policy / availability / transport.
 */
const summariseExtractFailure = (
  err: unknown,
): { unavailable: boolean; reason: string } => {
  const message = err instanceof Error ? err.message : String(err);
  const causeMessage =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  const haystack = `${message} ${causeMessage}`.toLowerCase();
  const unavailable = [
    "no endpoints",
    "data policy",
    "no allowed providers",
    "rate limit",
    "quota",
    "overloaded",
    "timed out",
    "timeout",
    "aborted",
    "fetch failed",
    "network",
  ].some((needle) => haystack.includes(needle));
  const reason = (message || "unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return { unavailable, reason };
};

/** Merge section outcomes into the tool-facing result envelope. */
export const assembleExtractResult = (
  outcomes: SectionOutcome[],
  shape: ExtractShape,
  pagesTotal: number | null,
  coveredLabel: string,
  models: Pick<ExtractModels, "primaryId" | "fallbackId">,
): StructuredExtractResult => {
  const notices: string[] = [];
  for (const outcome of outcomes) {
    const rangeArg =
      outcome.pages.length > 0
        ? ` with pages:"${formatPageRanges(outcome.pages)}"`
        : "";
    if (outcome.failed) {
      const cause = outcome.error ? ` (${outcome.error})` : "";
      notices.push(
        outcome.unavailable
          ? `${describeRange(outcome.pages)}: extraction is temporarily unavailable${cause} — a backend/routing outage, not a document problem. Report it; do NOT hand-parse the document with a script.`
          : `${describeRange(outcome.pages)} could not be extracted${cause}. Report it; do NOT hand-parse the document with a layout-specific script.`,
      );
    } else if (outcome.truncated) {
      notices.push(
        `${describeRange(outcome.pages)} has more records than fit in one response — re-call extract${rangeArg} on a narrower page range to get the rest.`,
      );
    } else if (
      shape === "records" &&
      outcome.reportedTotal !== null &&
      outcome.rows.length !== outcome.reportedTotal
    ) {
      // The extractor's own count disagrees with what it returned. Measured on
      // one 5-page invoice: 26, then 31, then 1, for 21 real lines — the count
      // is a weak signal in BOTH directions, so this only reports the
      // disagreement. Nothing is re-run on the strength of it.
      notices.push(
        `${describeRange(outcome.pages)}: ${outcome.rows.length.toString()} records returned, but the extractor counted ${outcome.reportedTotal.toString()} — its count is unreliable and one of the two is wrong. If the row count matters, check it against the document, or re-call extract${rangeArg} on a narrower page range.`,
      );
    }
  }
  const totalDropped = outcomes.reduce((sum, o) => sum + o.dropped, 0);
  if (totalDropped > 0) {
    notices.push(
      `${totalDropped} record(s) were dropped as unreadable/invalid against the field types — check the source or loosen a field type if a value was legitimate.`,
    );
  }

  // Dedup once more across sections (a record spanning a section boundary can
  // appear twice); order-preserving.
  const usedFallback = outcomes.some((o) => o.usedFallback);
  let data: { records: ExtractedRow[] } | { record: ExtractedRow };
  let empty: boolean;
  if (shape === "records") {
    const seen = new Set<string>();
    const merged: ExtractedRow[] = [];
    for (const outcome of outcomes) {
      for (const row of outcome.rows) {
        const key = recordKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
      }
    }
    data = { records: merged };
    empty = merged.length === 0;
  } else {
    const record = outcomes.find((o) => o.singleRecord)?.singleRecord ?? {};
    data = { record };
    empty = Object.keys(record).length === 0;
  }

  // An empty result is never silently "complete" — either an earlier notice
  // already explains it, or the agent must be told to re-target, not to trust
  // an empty result as ground truth.
  if (notices.length === 0 && empty) {
    notices.push(
      shape === "records"
        ? "No records matched — nothing was extracted. Check that the file/pages target the right content or sharpen `instructions`; if the document genuinely contains no matching records, report that."
        : "The requested fields could not be read into a record — re-call with sharper instructions or a narrower page range; do not invent values.",
    );
  }

  const counted = outcomes.reduce<number | null>(
    (sum, o) => (o.reportedTotal === null ? sum : (sum ?? 0) + o.reportedTotal),
    null,
  );
  const returned = "records" in data ? data.records.length : empty ? 0 : 1;
  return {
    model: usedFallback
      ? `${models.primaryId}+${models.fallbackId}`
      : models.primaryId,
    pagesTotal,
    pagesCovered: coveredLabel,
    chunks: outcomes.length,
    recordsReturned: returned,
    modelCountedTotal: counted,
    complete: notices.length === 0,
    notices,
    data,
  };
};

export const runStructuredExtract = async (
  args: RunStructuredExtractArgs,
): Promise<StructuredExtractResult> => {
  const ctx: CallContext = {
    prepared: args.prepared,
    shape: args.shape,
    instructions: args.instructions,
    pagesTotal: args.source.kind === "image" ? 1 : args.source.pagesTotal,
    models: await extractModelsFor(args.teamId),
  };

  if (args.source.kind === "image") {
    const { bytes, mimeType, filename } = args.source;
    const outcome = await runNativeCall(ctx, [], {
      bytes,
      mediaType: mimeType,
      filename,
    });
    return assembleExtractResult([outcome], args.shape, 1, "all", ctx.models);
  }

  const source = args.source;
  const file = (bytes: Uint8Array): CallFile => ({
    bytes,
    mediaType: "application/pdf",
    filename: source.filename,
  });

  // Unsplittable (encrypted/non-standard) or empty selection → one whole-doc call.
  if (!source.splittable || source.selectedPages.length === 0) {
    const outcome = await runNativeCall(ctx, [], file(source.bytes));
    return assembleExtractResult(
      [outcome],
      args.shape,
      source.pagesTotal,
      source.splittable ? "all" : "all (unsplittable)",
      ctx.models,
    );
  }

  const selected = source.selectedPages;

  // Whole-doc single call — the common, verified path.
  if (selected.length <= EXTRACT_WHOLE_DOC_MAX_PAGES) {
    const isWholeDoc =
      source.pagesTotal !== null && selected.length === source.pagesTotal;
    const bytes = isWholeDoc
      ? source.bytes
      : ((await slicePdfPages(source.bytes, selected)) ?? source.bytes);
    const outcome = await runNativeCall(ctx, selected, file(bytes));
    return assembleExtractResult(
      [outcome],
      args.shape,
      source.pagesTotal,
      isWholeDoc ? "all" : formatPageRanges(selected),
      ctx.models,
    );
  }

  // Large document → section calls (bounded parallelism), merged + deduped.
  const sections = planSections(selected);
  const outcomes: SectionOutcome[] = [];
  for (let i = 0; i < sections.length; i += EXTRACT_SECTION_CONCURRENCY) {
    const batch = sections.slice(i, i + EXTRACT_SECTION_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (pages) => {
        const slice = await slicePdfPages(source.bytes, pages);
        return runNativeCall(ctx, pages, file(slice ?? source.bytes));
      }),
    );
    outcomes.push(...settled);
  }
  return assembleExtractResult(
    outcomes,
    args.shape,
    source.pagesTotal,
    formatPageRanges(selected),
    ctx.models,
  );
};
