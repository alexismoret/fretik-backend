import { type JSONSchema7, type LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, jsonSchema, Output, type Schema } from "ai";
import { Ajv, type ValidateFunction } from "ajv";
import { mapBounded } from "./bounded-map";
import { describeLlmError } from "./describe-llm-error";
import { telemetryFor } from "./langfuse";
import { resolveModel } from "./model-registry/resolve";
import { formatPageRanges, slicePdfPages } from "./pdf-pages";
import { SCHEMA_BLOCK_TRAILER } from "./schema-prompt";

/**
 * Structured-extraction engine behind the `extract` tool. The agent
 * supplies a near-complete JSON Schema for ONE record; a vision-capable
 * model (registry role `extract`, native-PDF via OpenRouter's
 * `file-parser` plugin, same route as `lib/vision.ts`) fills it through
 * `Output.object` + the AI SDK's `jsonSchema()` helper — no Zod
 * conversion layer. Ajv validates twice: the agent's schema at compile
 * time (bad schemas fail BEFORE any model call, with an agent-readable
 * message) and every model output at parse time (belt-and-suspenders
 * for providers that silently downgrade strict json_schema mode).
 *
 * The agent supplies STANDARD JSON Schema (draft-07). A deterministic
 * lowering pass (`lowerAgentSchema`) normalizes the shapes a model
 * actually emits — bare property maps, `anyOf`/`nullable` idioms,
 * `$ref` + `$defs`, `allOf`, annotations, missing `type` — into the
 * provider-safe subset the bounds walk (`sanitizeNode`) enforces:
 * `type` (incl. unions with "null"), nested `properties` / `items` to
 * depth 6, `required`, `enum`, `const`, numeric/string/array
 * constraints, `description`. Strict structured-output providers don't
 * honour `$ref`/composition, so they are inlined/collapsed here rather
 * than forwarded. Every scalar/enum property is auto-relaxed to admit
 * `null` so an absent value never forces the extractor to invent one.
 *
 * Large PDFs are split into page-range chunks (pdf-lib) so no single
 * call can silently drop rows to an output cap. Failure handling per
 * chunk: a parse/model error re-chunks by halving the page range
 * (8 → 4 → 2); at minimum size the same range retries once on the
 * `extract-fallback` role before the range is reported as failed. A
 * chunk that returns valid JSON but stopped on `finishReason ===
 * "length"` keeps its data and is reported as truncated — `complete`
 * and `notices` tell the agent exactly which pages to re-call.
 *
 * Deliberately NOT merged with `services/pre-extract`: that pipeline
 * owns a team-configured universal schema (Zod, from field
 * definitions) and page *down-selection* (classification); this engine
 * owns agent-supplied schemas and page *coverage* (extraction). They
 * share the schema-in-prompt defense and the structured-output call
 * shape.
 */

const extractPrimary = resolveModel("extract");
const extractFallback = resolveModel("extract-fallback");

const EXTRACT_MODEL_ID = extractPrimary.profile.catalog.id;
const EXTRACT_FALLBACK_MODEL_ID = extractFallback.profile.catalog.id;

/** Pages per PDF chunk — 8 keeps input ≈4-5K tokens and output well under the cap. */
export const EXTRACT_PAGES_PER_CHUNK = 8;
/** Below this size a failing chunk stops halving and tries the fallback model. */
export const EXTRACT_MIN_CHUNK_PAGES = 2;
/** Bounded parallelism across chunk calls. */
const EXTRACT_CHUNK_CONCURRENCY = 2;
/** `record` shape reads at most this many pages (first 10 + last 6 when larger). */
export const EXTRACT_RECORD_MODE_MAX_PAGES = 16;
const EXTRACT_RECORD_MODE_HEAD_PAGES = 10;
/** Char budget per text-mode (OCR markdown) chunk — ≈15K tokens. */
export const EXTRACT_TEXT_CHUNK_CHAR_BUDGET = 60_000;

const EXTRACT_TEMPERATURE = 0;
const EXTRACT_MAX_OUTPUT_TOKENS = 8_000;
const EXTRACT_TIMEOUT_MS = 90_000;

/** Bounds on the agent-supplied schema. */
const EXTRACT_SCHEMA_MAX_DEPTH = 6;
const EXTRACT_SCHEMA_MAX_PROPERTIES = 120;

export type ExtractShape = "records" | "record";

export type ExtractedRow = Record<string, unknown>;

/** One page of already-extracted markdown (OCR sidecar) for text mode. */
export interface ExtractTextPage {
  /** 1-based page number as shown to the model. */
  pageNumber: number;
  markdown: string;
}

export type ExtractSource =
  | {
      kind: "pdf";
      bytes: Uint8Array;
      filename: string;
      /** Sorted 1-based pages to cover. Empty + `splittable: false` = whole doc. */
      selectedPages: number[];
      /** Total pages, `null` when the PDF could not be parsed locally. */
      pagesTotal: number | null;
      /** False when pdf-lib cannot re-assemble the doc (encrypted/corrupt). */
      splittable: boolean;
    }
  | { kind: "image"; bytes: Uint8Array; mimeType: string; filename: string }
  | { kind: "text"; pages: ExtractTextPage[]; pagesTotal: number };

export interface RunStructuredExtractArgs {
  source: ExtractSource;
  /** Prepared via `prepareExtractionSchema` (the tool validates first). */
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
  chunks: number;
  /** False when any chunk was truncated or failed — see `notices`. */
  complete: boolean;
  /** Agent-directive follow-up guidance (which pages to re-call, and how). */
  notices: string[];
  data: { records: ExtractedRow[] } | { record: ExtractedRow };
}

// ============================================================================
// Schema sanitization (agent JSON Schema → bounded JSONSchema7)
// ============================================================================

const ALLOWED_TYPE_NAMES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
] as const;
type AllowedTypeName = (typeof ALLOWED_TYPE_NAMES)[number];

const isAllowedTypeName = (value: unknown): value is AllowedTypeName =>
  typeof value === "string" &&
  (ALLOWED_TYPE_NAMES as readonly string[]).includes(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type EnumValue = string | number | boolean | null;

const isEnumValue = (value: unknown): value is EnumValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const ALLOWED_KEYWORDS =
  "type, properties, required, items, enum, const, description, title, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern, format, minItems, maxItems, additionalProperties";

interface SanitizeCounters {
  properties: number;
}

interface SchemaError {
  error: string;
}

const isSchemaError = (value: unknown): value is SchemaError =>
  isPlainObject(value) && typeof value["error"] === "string";

const NUMERIC_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
] as const;

const STRING_KEYWORDS = ["description", "title", "pattern", "format"] as const;

/**
 * Relax a leaf property schema so `null` is always a legal value —
 * an absent field must never force the extractor to invent one.
 * Object/array-typed properties are left alone (the model returns an
 * empty container instead).
 */
const admitNull = (node: JSONSchema7): void => {
  if (Array.isArray(node.enum) && !node.enum.includes(null)) {
    node.enum = [...node.enum, null];
  }
  const type = node.type;
  if (
    typeof type === "string" &&
    type !== "object" &&
    type !== "array" &&
    type !== "null"
  ) {
    node.type = [type, "null"];
  } else if (
    Array.isArray(type) &&
    !type.includes("null") &&
    !type.includes("object") &&
    !type.includes("array")
  ) {
    node.type = [...type, "null"];
  }
};

const sanitizeNode = (
  raw: unknown,
  path: string,
  depth: number,
  counters: SanitizeCounters,
): JSONSchema7 | SchemaError => {
  if (!isPlainObject(raw)) {
    return { error: `Schema node at "${path}" must be an object.` };
  }
  if (depth > EXTRACT_SCHEMA_MAX_DEPTH) {
    return {
      error: `Schema exceeds the maximum nesting depth (${EXTRACT_SCHEMA_MAX_DEPTH}) at "${path}".`,
    };
  }

  const out: JSONSchema7 = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "type": {
        if (isAllowedTypeName(value)) {
          out.type = value;
        } else if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every(isAllowedTypeName)
        ) {
          out.type = value;
        } else {
          return {
            error: `Invalid "type" at "${path}" — allowed: ${ALLOWED_TYPE_NAMES.join(", ")} (string or array of strings).`,
          };
        }
        break;
      }
      case "properties": {
        if (!isPlainObject(value)) {
          return { error: `"properties" at "${path}" must be an object.` };
        }
        const properties: Record<string, JSONSchema7> = {};
        for (const [propName, propRaw] of Object.entries(value)) {
          counters.properties += 1;
          if (counters.properties > EXTRACT_SCHEMA_MAX_PROPERTIES) {
            return {
              error: `Schema declares more than ${EXTRACT_SCHEMA_MAX_PROPERTIES} properties in total — trim it, or extract in several calls.`,
            };
          }
          const sanitized = sanitizeNode(
            propRaw,
            `${path}.${propName}`,
            depth + 1,
            counters,
          );
          if (isSchemaError(sanitized)) return sanitized;
          admitNull(sanitized);
          properties[propName] = sanitized;
        }
        out.properties = properties;
        break;
      }
      case "items": {
        const sanitized = sanitizeNode(
          value,
          `${path}.items`,
          depth + 1,
          counters,
        );
        if (isSchemaError(sanitized)) return sanitized;
        out.items = sanitized;
        break;
      }
      case "required": {
        if (
          !Array.isArray(value) ||
          !value.every((v) => typeof v === "string")
        ) {
          return {
            error: `"required" at "${path}" must be an array of strings.`,
          };
        }
        out.required = value;
        break;
      }
      case "enum": {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          !value.every(isEnumValue)
        ) {
          return {
            error: `"enum" at "${path}" must be a non-empty array of strings/numbers/booleans/null.`,
          };
        }
        out.enum = value;
        break;
      }
      case "const": {
        if (!isEnumValue(value)) {
          return {
            error: `"const" at "${path}" must be a string/number/boolean/null.`,
          };
        }
        out.const = value;
        break;
      }
      case "additionalProperties": {
        if (typeof value !== "boolean") {
          return {
            error: `"additionalProperties" at "${path}" must be a boolean.`,
          };
        }
        out.additionalProperties = value;
        break;
      }
      default: {
        if ((STRING_KEYWORDS as readonly string[]).includes(key)) {
          if (typeof value !== "string") {
            return { error: `"${key}" at "${path}" must be a string.` };
          }
          if (key === "description") out.description = value;
          else if (key === "title") out.title = value;
          else if (key === "pattern") out.pattern = value;
          else out.format = value;
          break;
        }
        if ((NUMERIC_KEYWORDS as readonly string[]).includes(key)) {
          if (typeof value !== "number") {
            return { error: `"${key}" at "${path}" must be a number.` };
          }
          if (key === "minimum") out.minimum = value;
          else if (key === "maximum") out.maximum = value;
          else if (key === "exclusiveMinimum") out.exclusiveMinimum = value;
          else if (key === "exclusiveMaximum") out.exclusiveMaximum = value;
          else if (key === "minLength") out.minLength = value;
          else if (key === "maxLength") out.maxLength = value;
          else if (key === "minItems") out.minItems = value;
          else out.maxItems = value;
          break;
        }
        return {
          error: `Unsupported schema keyword "${key}" at "${path}". Allowed keywords: ${ALLOWED_KEYWORDS}. $ref, $defs and allOf/anyOf/oneOf/not are not supported — inline the structure instead.`,
        };
      }
    }
  }
  return out;
};

// ============================================================================
// Draft-07 lowering — accept a STANDARD JSON Schema and normalize it into the
// provider-safe subset the strict bounds walk (`sanitizeNode`) enforces,
// repairing the shapes a model actually emits instead of rejecting them:
// bare property maps, `anyOf`/`nullable` idioms, `$ref`/`$defs`, `allOf`,
// annotations, missing `type`, field definitions misplaced next to
// `properties`, non-array `required`. Deterministic, runs before `sanitizeNode`, and
// only ever LOWERS — a schema that is already in the subset passes through
// byte-for-byte. Genuinely un-lowerable input (empty, over-depth, >120 fields)
// still fails, in `sanitizeNode`, with an agent-readable message.
// ============================================================================

/** Keywords carried through to the provider subset. Everything else is either
 * consumed (composition/nullable → lowered) or dropped (annotations). */
const PASSTHROUGH_KEYWORDS = new Set<string>([
  "type",
  "properties",
  "items",
  "required",
  "enum",
  "const",
  "description",
  "title",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "additionalProperties",
]);

/** Presence of any of these means the node already declares its own shape, so
 * it is NOT a bare "these are my fields" property map. */
const STRUCTURAL_KEYWORDS = new Set<string>([
  "type",
  "properties",
  "items",
  "enum",
  "const",
]);

/** Keywords that legitimately carry object values on an object node — never
 * lifted into `properties` as misplaced field definitions (step 5b). */
const NEVER_LIFT_KEYWORDS = new Set<string>([
  "type",
  "properties",
  "items",
  "required",
  "enum",
  "const",
  "additionalProperties",
]);

/** A node describing only `null` — the null branch of a nullable union. */
const isNullOnlyNode = (node: Record<string, unknown>): boolean =>
  node["type"] === "null" ||
  (Array.isArray(node["type"]) &&
    node["type"].length === 1 &&
    node["type"][0] === "null");

/** Add `"null"` to a `type` value (string → tuple, tuple → union). */
const withNull = (type: unknown): unknown => {
  if (typeof type === "string") return type === "null" ? type : [type, "null"];
  if (Array.isArray(type))
    return type.includes("null") ? type : [...type, "null"];
  return type;
};

/** Merge `source`'s keywords into `target` (for `allOf` members + a resolved
 * `$ref`'s siblings): `properties` union, `required` union, other keywords
 * fill only where `target` is silent. */
const mergeSchemaInto = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    if (key === "properties" && isPlainObject(value)) {
      const existing = isPlainObject(target["properties"])
        ? target["properties"]
        : {};
      target["properties"] = { ...existing, ...value };
    } else if (key === "required" && Array.isArray(value)) {
      const existing = Array.isArray(target["required"])
        ? target["required"]
        : [];
      target["required"] = [...new Set([...existing, ...value])];
    } else if (!(key in target)) {
      target[key] = value;
    }
  }
};

/** Resolve a LOCAL `$ref` (`#/$defs/Name` or `#/definitions/Name`) against the
 * root definition maps. External / unknown pointers return undefined (dropped). */
const resolveLocalRef = (
  ref: string,
  defs: Record<string, unknown>,
): unknown => {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  const name = match?.[1];
  if (name === undefined) return undefined;
  return defs[name];
};

interface LowerContext {
  /** Flattened root `$defs` + `definitions`, for `$ref` inlining. */
  defs: Record<string, unknown>;
  /** `$ref`s currently being expanded — cycle guard. */
  refStack: Set<string>;
}

const collectDefs = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of ["$defs", "definitions"] as const) {
    const value = raw[key];
    if (isPlainObject(value)) Object.assign(out, value);
  }
  return out;
};

/**
 * Lower one node of an agent-supplied draft-07 schema into the provider-safe
 * subset. Order matters: dereference/compose first (`$ref`, `allOf`,
 * `anyOf`/`oneOf`) so later steps see the resolved shape, then structural
 * repair (bare map, array-`properties`), then recurse, then infer `type` and
 * apply nullability, then keep only supported keywords.
 */
const lowerNode = (
  input: unknown,
  ctx: LowerContext,
  depth: number,
): unknown => {
  if (!isPlainObject(input)) return input;
  // Guard runaway `$ref` chains; bounds are enforced later by sanitizeNode.
  if (depth > EXTRACT_SCHEMA_MAX_DEPTH + 4) return { type: "object" };

  let node: Record<string, unknown> = { ...input };
  let nullable = node["nullable"] === true;
  delete node["nullable"];

  // 1. $ref → inline the local definition (cycle-guarded). The resolved
  //    schema is the base; any sibling keywords (e.g. an added description)
  //    merge on top, matching how models annotate a $ref in practice.
  const ref = node["$ref"];
  if (typeof ref === "string") {
    delete node["$ref"];
    if (!ctx.refStack.has(ref)) {
      const target = resolveLocalRef(ref, ctx.defs);
      if (isPlainObject(target)) {
        ctx.refStack.add(ref);
        const resolved = lowerNode(target, ctx, depth + 1);
        ctx.refStack.delete(ref);
        if (isPlainObject(resolved)) {
          const base = { ...resolved };
          mergeSchemaInto(base, node);
          node = base;
        }
      }
    }
  }

  // 2. allOf → merge each member into the node.
  const allOf = node["allOf"];
  delete node["allOf"];
  if (Array.isArray(allOf)) {
    for (const member of allOf) {
      const lowered = lowerNode(member, ctx, depth + 1);
      if (isPlainObject(lowered)) mergeSchemaInto(node, lowered);
    }
  }

  // 3. anyOf / oneOf → collapse. A `null` branch marks the node nullable; the
  //    first non-null branch is merged in (extraction rarely needs a true
  //    union, and a single concrete shape is what the provider can honour).
  for (const key of ["anyOf", "oneOf"] as const) {
    const union = node[key];
    delete node[key];
    if (!Array.isArray(union) || union.length === 0) continue;
    const branches = union.filter(isPlainObject);
    const nonNull = branches.filter((b) => !isNullOnlyNode(b));
    if (nonNull.length < branches.length) nullable = true;
    const first = nonNull[0];
    if (first) {
      const lowered = lowerNode(first, ctx, depth + 1);
      if (isPlainObject(lowered)) mergeSchemaInto(node, lowered);
    }
  }

  // 4. Bare property map (no structural keyword, but object-valued entries) →
  //    treat those entries as `properties`. Object-valued keeps a stray scalar
  //    keyword (e.g. a real `description` string) out of the field set, while
  //    still capturing a field the model happened to name "description".
  const hasStructural = [...STRUCTURAL_KEYWORDS].some((k) => k in node);
  if (!hasStructural) {
    const fieldEntries = Object.entries(node).filter(([, v]) =>
      isPlainObject(v),
    );
    if (fieldEntries.length > 0) {
      const properties: Record<string, unknown> = {};
      for (const [name, value] of fieldEntries) {
        properties[name] = value;
        delete node[name];
      }
      node["type"] = "object";
      node["properties"] = properties;
    }
  }

  // 5. `properties` given as an array of `{name, ...schema}` → object map.
  if (Array.isArray(node["properties"])) {
    const properties: Record<string, unknown> = {};
    for (const entry of node["properties"]) {
      if (!isPlainObject(entry)) continue;
      const name = entry["name"];
      if (typeof name !== "string") continue;
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (key !== "name") rest[key] = value;
      }
      properties[name] = rest;
    }
    node["properties"] = properties;
  }

  // 5b. Field definitions dropped NEXT TO `properties` (the model put them at
  //     the wrong nesting level) → lift schema-shaped object siblings into
  //     `properties` instead of erroring on a keyword collision (`format`) or
  //     silently losing the field.
  const isObjectNode =
    node["type"] === "object" ||
    (Array.isArray(node["type"]) && node["type"].includes("object")) ||
    isPlainObject(node["properties"]);
  if (isObjectNode) {
    const existing = isPlainObject(node["properties"])
      ? node["properties"]
      : {};
    let lifted: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(node)) {
      if (NEVER_LIFT_KEYWORDS.has(key)) continue;
      if (!isPlainObject(value)) continue;
      const looksLikeSchema =
        [...STRUCTURAL_KEYWORDS].some((k) => k in value) ||
        "description" in value;
      if (!looksLikeSchema) continue;
      delete node[key];
      if (key in existing) continue;
      (lifted ??= {})[key] = value;
    }
    if (lifted) node["properties"] = { ...existing, ...lifted };
  }

  // 6. Recurse into properties + items.
  if (isPlainObject(node["properties"])) {
    const lowered: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node["properties"])) {
      lowered[name] = lowerNode(value, ctx, depth + 1);
    }
    node["properties"] = lowered;
  }
  if (node["items"] !== undefined && !Array.isArray(node["items"])) {
    node["items"] = lowerNode(node["items"], ctx, depth + 1);
  }

  // 7. Infer a missing `type` from structure.
  if (node["type"] === undefined) {
    if (isPlainObject(node["properties"])) node["type"] = "object";
    else if (node["items"] !== undefined) node["type"] = "array";
    else if (!Array.isArray(node["enum"]) && node["const"] === undefined) {
      // A described leaf with nothing else is a string field.
      node["type"] = "string";
    }
  }

  // 8. Prune `required` to properties that actually exist.
  if (Array.isArray(node["required"]) && isPlainObject(node["properties"])) {
    const known = node["properties"];
    node["required"] = node["required"].filter(
      (r): r is string => typeof r === "string" && r in known,
    );
  }

  // 9. Apply nullability to the (possibly inferred) type.
  if (nullable && node["type"] !== undefined) {
    node["type"] = withNull(node["type"]);
  }

  // 10. Keep only supported keywords (drops annotations + consumed leftovers).
  //     A non-boolean `additionalProperties` (draft allows a schema) is dropped
  //     rather than passed to the boolean-only bounds check.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!PASSTHROUGH_KEYWORDS.has(key)) continue;
    if (key === "additionalProperties" && typeof value !== "boolean") continue;
    // Draft-04 style `required: true` (or any non-array) → drop, not error.
    if (key === "required" && !Array.isArray(value)) continue;
    out[key] = value;
  }
  return out;
};

/** Lower an agent-supplied draft-07 schema into the subset `sanitizeNode`
 * enforces. Non-object input is returned untouched for `sanitizeNode` to reject. */
const lowerAgentSchema = (raw: unknown): unknown => {
  if (!isPlainObject(raw)) return raw;
  const ctx: LowerContext = { defs: collectDefs(raw), refStack: new Set() };
  return lowerNode(raw, ctx, 0);
};

/**
 * Lower (accept standard draft-07), then validate + bound the agent-supplied
 * record schema. Exported for tests; the tool calls `prepareExtractionSchema`
 * which also wraps and Ajv-compiles it.
 */
export const sanitizeExtractSchema = (
  raw: unknown,
): JSONSchema7 | SchemaError => {
  const counters: SanitizeCounters = { properties: 0 };
  const sanitized = sanitizeNode(lowerAgentSchema(raw), "schema", 0, counters);
  if (isSchemaError(sanitized)) return sanitized;
  const isObjectType =
    sanitized.type === "object" ||
    (Array.isArray(sanitized.type) && sanitized.type.includes("object")) ||
    (sanitized.type === undefined && sanitized.properties !== undefined);
  if (
    !isObjectType ||
    !sanitized.properties ||
    Object.keys(sanitized.properties).length === 0
  ) {
    return {
      error:
        'The schema must describe an object: {"type":"object","properties":{...}} with at least one property.',
    };
  }
  sanitized.type = "object";
  return sanitized;
};

// ============================================================================
// Prepared schema (wrapped + Ajv-compiled + AI-SDK Schema)
// ============================================================================

interface ExtractLlmEnvelope {
  records?: ExtractedRow[];
  record?: ExtractedRow;
}

export interface PreparedExtractionSchema {
  /** Full wrapped schema sent to the provider and embedded in the prompt. */
  wrapped: JSONSchema7;
  /** Pretty-printed `wrapped` for the system-prompt `<schema>` block. */
  promptSchema: string;
  /** AI-SDK schema with Ajv validation plugged in. */
  outputSchema: Schema<ExtractLlmEnvelope>;
}

const ajv = new Ajv({
  strict: false,
  validateFormats: false,
  allErrors: false,
});

const buildValidate =
  (validateFn: ValidateFunction) =>
  (
    value: unknown,
  ):
    | { success: true; value: ExtractLlmEnvelope }
    | { success: false; error: Error } => {
    if (!validateFn(value)) {
      return {
        success: false,
        error: new Error(
          `Extraction output failed schema validation: ${ajv.errorsText(validateFn.errors)}`,
        ),
      };
    }
    if (!isPlainObject(value)) {
      return {
        success: false,
        error: new Error("Extraction output is not an object."),
      };
    }
    const envelope: ExtractLlmEnvelope = {};
    const records = value["records"];
    if (Array.isArray(records)) {
      envelope.records = records.filter(isPlainObject);
    }
    const record = value["record"];
    if (isPlainObject(record)) {
      envelope.record = record;
    }
    return { success: true, value: envelope };
  };

/**
 * Sanitize the agent's record schema, wrap it per shape
 * (`{records: [...]}` / `{record: {...}}` — a stable top level keeps
 * cross-chunk merging well-defined for ANY record schema), and compile
 * with Ajv. An invalid schema returns an agent-readable error before
 * any model call.
 */
export const prepareExtractionSchema = (
  raw: unknown,
  shape: ExtractShape,
): PreparedExtractionSchema | SchemaError => {
  const sanitized = sanitizeExtractSchema(raw);
  if (isSchemaError(sanitized)) return sanitized;

  const wrapped: JSONSchema7 =
    shape === "records"
      ? {
          type: "object",
          properties: { records: { type: "array", items: sanitized } },
          required: ["records"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: { record: sanitized },
          required: ["record"],
          additionalProperties: false,
        };

  let validateFn: ValidateFunction;
  try {
    validateFn = ajv.compile(wrapped);
  } catch (compileError) {
    return {
      error: `The schema does not compile as JSON Schema: ${compileError instanceof Error ? compileError.message : String(compileError)}`,
    };
  }

  return {
    wrapped,
    promptSchema: JSON.stringify(wrapped, null, 2),
    outputSchema: jsonSchema<ExtractLlmEnvelope>(wrapped, {
      validate: buildValidate(validateFn),
    }),
  };
};

// ============================================================================
// Chunk planning
// ============================================================================

/** Split a sorted page list into chunks of at most `chunkSize`. */
export const planPageChunks = (
  pages: readonly number[],
  chunkSize: number = EXTRACT_PAGES_PER_CHUNK,
): number[][] => {
  const chunks: number[][] = [];
  for (let index = 0; index < pages.length; index += chunkSize) {
    chunks.push(pages.slice(index, index + chunkSize));
  }
  return chunks;
};

/** First 10 + last 6 pages when the selection exceeds the record-mode cap. */
export const selectRecordModePages = (pages: readonly number[]): number[] => {
  if (pages.length <= EXTRACT_RECORD_MODE_MAX_PAGES) return [...pages];
  const head = pages.slice(0, EXTRACT_RECORD_MODE_HEAD_PAGES);
  const tail = pages.slice(
    pages.length -
      (EXTRACT_RECORD_MODE_MAX_PAGES - EXTRACT_RECORD_MODE_HEAD_PAGES),
  );
  return [...head, ...tail];
};

/** Group OCR-markdown pages into chunks under the text char budget. */
export const planTextChunks = (
  pages: readonly ExtractTextPage[],
  charBudget: number = EXTRACT_TEXT_CHUNK_CHAR_BUDGET,
): ExtractTextPage[][] => {
  const chunks: ExtractTextPage[][] = [];
  let current: ExtractTextPage[] = [];
  let currentChars = 0;
  for (const page of pages) {
    // A single page above the budget is truncated — text mode carries
    // born-digital Office markdown, where this is a degenerate case.
    const markdown =
      page.markdown.length > charBudget
        ? `${page.markdown.slice(0, charBudget)}\n[page truncated]`
        : page.markdown;
    if (current.length > 0 && currentChars + markdown.length > charBudget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push({ pageNumber: page.pageNumber, markdown });
    currentChars += markdown.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

// ============================================================================
// LLM calls
// ============================================================================

/**
 * Aux-LLM system prompt (agent-context framework applies — keep it a
 * ruleset, not prose). The `<schema>` block + trailer are appended per
 * call because the schema is dynamic.
 */
const EXTRACT_SYSTEM_PROMPT = `You are a precise document-data extractor.

Rules:
- Extract ONLY values visible in the provided document content. Never infer, compute, or invent a value.
- A field whose value is absent or unreadable is null — never guess, never substitute a nearby value.
- Copy numbers and dates exactly as printed (dates re-formatted to the requested format; decimal commas become decimal points: 12,5 → 12.5; currency symbols and thousands separators excluded from numbers).
- When the schema has a "records" array: emit ONE record per occurrence (table row, line item, repeated block) in document order. Do not merge, dedupe, or summarise occurrences.
- You may be shown a page subset of a larger document — extract from the pages you see, nothing else.
- Field descriptions, enums and constraints in the schema are authoritative instructions.`;

interface LlmCallResult {
  rows: ExtractedRow[];
  singleRecord: ExtractedRow | null;
  truncated: boolean;
}

interface ChunkOutcome {
  /** 1-based pages this outcome covers (empty for image / unsplittable PDF). */
  pages: number[];
  rows: ExtractedRow[];
  singleRecord: ExtractedRow | null;
  truncated: boolean;
  failed: boolean;
  usedFallback: boolean;
}

interface CallContext {
  prepared: PreparedExtractionSchema;
  shape: ExtractShape;
  instructions?: string;
  pagesTotal: number | null;
}

interface CallFile {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
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

const buildCallText = (ctx: CallContext, pages: readonly number[]): string => {
  const parts = [buildCoverageNote(ctx, pages)];
  if (ctx.instructions) parts.push(ctx.instructions);
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

/**
 * One structured-output call. `file` is a native part (PDF slice /
 * image); `textContent` is the OCR-markdown alternative (text mode).
 * Valid-but-capped JSON is kept and flagged truncated.
 */
const callExtractLlm = async (
  model: LanguageModelV4,
  ctx: CallContext,
  pages: readonly number[],
  file: CallFile | null,
  textContent: string | null,
): Promise<LlmCallResult> => {
  const userText =
    textContent === null
      ? buildCallText(ctx, pages)
      : `${buildCallText(ctx, pages)}\n\n<document>\n${textContent}\n</document>`;

  const { output, finishReason } = await generateText({
    model,
    output: Output.object({ schema: ctx.prepared.outputSchema }),
    system: buildSystemPrompt(ctx),
    temperature: EXTRACT_TEMPERATURE,
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    // Nests under the `extract` tool call → under the turn trace.
    telemetry: telemetryFor("extract"),
    messages: [
      {
        role: "user",
        content:
          file === null
            ? [{ type: "text", text: userText }]
            : [
                {
                  type: "file",
                  data: file.bytes,
                  mediaType: file.mediaType,
                  filename: file.filename,
                },
                { type: "text", text: userText },
              ],
      },
    ],
    // Same native-PDF route as `describePdf` — bypass OpenRouter's
    // default Mistral-OCR conversion so the model sees the real layout.
    // Harmless for images/text (unknown plugin ids are dropped).
    providerOptions: {
      openrouter: {
        plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
      },
    },
  });

  return {
    rows: output.records ?? [],
    singleRecord: output.record ?? null,
    truncated: finishReason === "length",
  };
};

/** Single-call runner (image / unsplittable PDF / one text chunk) with plain fallback. */
const runSingleCall = async (
  ctx: CallContext,
  pages: number[],
  file: CallFile | null,
  textContent: string | null,
): Promise<ChunkOutcome> => {
  try {
    const result = await callExtractLlm(
      extractPrimary.model,
      ctx,
      pages,
      file,
      textContent,
    );
    return { pages, ...result, failed: false, usedFallback: false };
  } catch (primaryError) {
    console.warn(
      `[extract] call failed on ${EXTRACT_MODEL_ID}, retrying on ${EXTRACT_FALLBACK_MODEL_ID} — ${describeLlmError(primaryError)}`,
    );
    try {
      const result = await callExtractLlm(
        extractFallback.model,
        ctx,
        pages,
        file,
        textContent,
      );
      return { pages, ...result, failed: false, usedFallback: true };
    } catch (fallbackError) {
      console.error(
        `[extract] call failed on both models — ${describeLlmError(fallbackError)}`,
      );
      return {
        pages,
        rows: [],
        singleRecord: null,
        truncated: false,
        failed: true,
        usedFallback: true,
      };
    }
  }
};

/**
 * Run one PDF page-range chunk with the halve-then-fallback recovery
 * ladder. Returns one outcome per terminal range attempted.
 */
const runPdfChunk = async (
  ctx: CallContext,
  source: Extract<ExtractSource, { kind: "pdf" }>,
  pages: number[],
): Promise<ChunkOutcome[]> => {
  const slice =
    source.splittable && pages.length > 0
      ? await slicePdfPages(source.bytes, pages)
      : null;
  const file: CallFile = {
    bytes: slice ?? source.bytes,
    mediaType: "application/pdf",
    filename: source.filename,
  };

  try {
    const result = await callExtractLlm(
      extractPrimary.model,
      ctx,
      pages,
      file,
      null,
    );
    return [{ pages, ...result, failed: false, usedFallback: false }];
  } catch (primaryError) {
    if (source.splittable && pages.length > EXTRACT_MIN_CHUNK_PAGES) {
      console.warn(
        `[extract] chunk ${formatPageRanges(pages)} failed on ${EXTRACT_MODEL_ID}, halving — ${describeLlmError(primaryError)}`,
      );
      const half = Math.ceil(pages.length / 2);
      const first = await runPdfChunk(ctx, source, pages.slice(0, half));
      const second = await runPdfChunk(ctx, source, pages.slice(half));
      return [...first, ...second];
    }
    console.warn(
      `[extract] chunk ${formatPageRanges(pages)} failed on ${EXTRACT_MODEL_ID}, retrying on ${EXTRACT_FALLBACK_MODEL_ID} — ${describeLlmError(primaryError)}`,
    );
    try {
      const result = await callExtractLlm(
        extractFallback.model,
        ctx,
        pages,
        file,
        null,
      );
      return [{ pages, ...result, failed: false, usedFallback: true }];
    } catch (fallbackError) {
      console.error(
        `[extract] chunk ${formatPageRanges(pages)} failed on both models — ${describeLlmError(fallbackError)}`,
      );
      return [
        {
          pages,
          rows: [],
          singleRecord: null,
          truncated: false,
          failed: true,
          usedFallback: true,
        },
      ];
    }
  }
};

// ============================================================================
// Result assembly + entry point
// ============================================================================

const describeRange = (pages: readonly number[]): string =>
  pages.length === 0 ? "the document" : `pages ${formatPageRanges(pages)}`;

/** Merge chunk outcomes into the tool-facing result envelope. */
export const assembleExtractResult = (
  outcomes: ChunkOutcome[],
  shape: ExtractShape,
  pagesTotal: number | null,
  coveredLabel: string,
): StructuredExtractResult => {
  const notices: string[] = [];
  for (const outcome of outcomes) {
    const rangeArg =
      outcome.pages.length > 0
        ? ` with pages:"${formatPageRanges(outcome.pages)}"`
        : "";
    if (outcome.failed) {
      notices.push(
        `${describeRange(outcome.pages)} could not be extracted (model error) — re-call extract${rangeArg}, or fall back to read + python.`,
      );
    } else if (outcome.truncated) {
      notices.push(
        `${describeRange(outcome.pages)} hit the output cap — data up to the cap was kept; re-call extract${rangeArg} with a smaller schema or narrower instructions to get the rest.`,
      );
    }
  }
  const usedFallback = outcomes.some((outcome) => outcome.usedFallback);
  const data =
    shape === "records"
      ? { records: outcomes.flatMap((outcome) => outcome.rows) }
      : {
          record:
            outcomes.find((outcome) => outcome.singleRecord)?.singleRecord ??
            {},
        };
  return {
    model: usedFallback
      ? `${EXTRACT_MODEL_ID}+${EXTRACT_FALLBACK_MODEL_ID}`
      : EXTRACT_MODEL_ID,
    pagesTotal,
    pagesCovered: coveredLabel,
    chunks: outcomes.length,
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
  };

  if (args.source.kind === "image") {
    const { bytes, mimeType, filename } = args.source;
    const outcome = await runSingleCall(
      ctx,
      [],
      { bytes, mediaType: mimeType, filename },
      null,
    );
    return assembleExtractResult([outcome], args.shape, 1, "all");
  }

  if (args.source.kind === "text") {
    const allPageNumbers = args.source.pages.map((page) => page.pageNumber);
    const selected =
      args.shape === "record"
        ? selectRecordModePages(allPageNumbers)
        : allPageNumbers;
    const selectedSet = new Set(selected);
    const pages = args.source.pages.filter((page) =>
      selectedSet.has(page.pageNumber),
    );
    const chunks = args.shape === "record" ? [pages] : planTextChunks(pages);
    const outcomes = await mapBounded(
      chunks,
      EXTRACT_CHUNK_CONCURRENCY,
      (chunk) =>
        runSingleCall(
          ctx,
          chunk.map((page) => page.pageNumber),
          null,
          chunk
            .map((page) => `## Page ${page.pageNumber}\n\n${page.markdown}`)
            .join("\n\n"),
        ),
    );
    return assembleExtractResult(
      outcomes,
      args.shape,
      args.source.pagesTotal,
      formatPageRanges(selected),
    );
  }

  const source = args.source;
  if (!source.splittable || source.selectedPages.length === 0) {
    const outcome = await runSingleCall(
      ctx,
      [],
      {
        bytes: source.bytes,
        mediaType: "application/pdf",
        filename: source.filename,
      },
      null,
    );
    return assembleExtractResult(
      [outcome],
      args.shape,
      source.pagesTotal,
      source.splittable ? "all" : "all (unsplittable)",
    );
  }

  const selected =
    args.shape === "record"
      ? selectRecordModePages(source.selectedPages)
      : source.selectedPages;

  if (args.shape === "record") {
    const slice = await slicePdfPages(source.bytes, selected);
    const outcome = await runSingleCall(
      ctx,
      selected,
      {
        bytes: slice ?? source.bytes,
        mediaType: "application/pdf",
        filename: source.filename,
      },
      null,
    );
    return assembleExtractResult(
      [outcome],
      args.shape,
      source.pagesTotal,
      formatPageRanges(selected),
    );
  }

  const chunks = planPageChunks(selected);
  const outcomes = (
    await mapBounded(chunks, EXTRACT_CHUNK_CONCURRENCY, (chunk) =>
      runPdfChunk(ctx, source, chunk),
    )
  ).flat();
  return assembleExtractResult(
    outcomes,
    args.shape,
    source.pagesTotal,
    formatPageRanges(selected),
  );
};
