import { z } from "zod";
import type { FieldDefinition } from "../db/schema";
import {
  fieldOptions,
  isFreeform,
  isMultiMember,
  numberBounds,
  ratingMax,
} from "../db/schema/field-types";
import { normalizeEntityName } from "../utils/normalizeEntityName";

/**
 * Per-field Zod for a field definition. Shared by the pre-extract schema
 * builder (`buildPreExtractCustomShape`) and the record runtime validator
 * (`buildRecordShape`) so the type→Zod mapping lives in exactly one place.
 *
 * `strict` controls how tightly a value is validated. The two callers want
 * different strictness over the SAME field catalog:
 *   - record writes (`strict: true`) reject malformed values up front:
 *     `email` → RFC email, `url` → absolute URL, `number` honours
 *     `config.min`/`config.max`.
 *   - pre-extract (`strict` omitted/false) stays lenient — the LLM emits
 *     best-effort strings and a single malformed value must not fail the
 *     whole extraction. This keeps the historical pre-extract shape intact.
 *
 * Type→Zod mapping (concrete-typed, Twenty-inspired):
 *   - text                → z.string()
 *   - email               → z.email() (strict) | z.string() (lenient)
 *   - url                 → z.url() (strict) | z.string() (lenient)
 *   - number              → z.number() (+ min/max bounds when strict)
 *   - date                → z.string() YYYY-MM-DD
 *   - datetime            → z.string() ISO 8601
 *   - boolean             → z.boolean()
 *   - select              → z.enum(values) when options exist, else string
 *   - multi_select        → z.array(z.enum(values)) when options exist
 *                           (z.array(z.string()) when freeform or no options)
 *
 * Every field is `.nullish()` so partial writes pass and the LLM is free to
 * skip fields that are not present.
 */
export const zodForField = (
  def: FieldDefinition,
  options?: { strict?: boolean },
): z.ZodTypeAny => {
  const strict = options?.strict ?? false;
  const description = def.description ?? def.label;
  switch (def.type) {
    case "text": {
      return z.string().nullish().describe(description);
    }
    case "email": {
      const base = strict ? z.email() : z.string();
      return base.nullish().describe(description);
    }
    case "url": {
      const base = strict ? z.url() : z.string();
      return base.nullish().describe(description);
    }
    case "number":
    case "rating": {
      let base = z.number();
      if (strict) {
        const { min, max } = numberBounds(def.config);
        if (typeof min === "number") base = base.min(min);
        if (typeof max === "number") base = base.max(max);
        // A rating is a 0..ratingMax integer.
        if (def.type === "rating")
          base = base.min(0).max(ratingMax(def.config));
      }
      return base.nullish().describe(description);
    }
    case "phone": {
      return z.string().nullish().describe(description);
    }
    case "markdown": {
      return z.string().nullish().describe(description);
    }
    case "member": {
      // userId(s); resolved against team membership in the write service.
      const base = isMultiMember(def.config) ? z.array(z.string()) : z.string();
      return base.nullish().describe(description);
    }
    case "money": {
      return z
        .object({ amount: z.number(), currencyCode: z.string() })
        .nullish()
        .describe(description);
    }
    case "relation":
    case "rollup": {
      // Neither is stored in `data`: relations live in the `links` graph and
      // rollups are aggregates computed in the typed view. `buildRecordShape`
      // skips both; this branch only keeps the switch exhaustive.
      return z.unknown().nullish().describe(description);
    }
    case "boolean": {
      return z.boolean().nullish().describe(description);
    }
    case "date": {
      return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
        .nullish()
        .describe(
          `${description} Format: YYYY-MM-DD (calendar date only, no time component).`,
        );
    }
    case "datetime": {
      return z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/,
          "Expected ISO 8601 datetime",
        )
        .nullish()
        .describe(
          `${description} Format: ISO 8601 datetime (e.g. 2025-01-15T10:30:00Z).`,
        );
    }
    case "select": {
      const values = optionValues(def);
      if (values.length === 0)
        return z.string().nullish().describe(description);
      return z
        .enum(values as [string, ...string[]])
        .nullish()
        .describe(description);
    }
    case "multi_select": {
      const values = optionValues(def);
      const freeform = isFreeform(def.config);
      if (values.length === 0 || freeform) {
        return z.array(z.string()).nullish().describe(description);
      }
      return z
        .array(z.enum(values as [string, ...string[]]))
        .nullish()
        .describe(description);
    }
  }
};

const optionValues = (def: FieldDefinition): string[] =>
  fieldOptions(def.config).map((o) => o.value);

/**
 * Build the strict runtime Zod object an object record's `data` validates
 * against. Generalizes `buildPreExtractCustomShape`: one optional key per
 * ENABLED field definition (filtered by `enabled` only — every enabled field
 * is user-writable, regardless of `aiExtractionEnabled`). Concrete-typed and
 * every field `.nullish()`, so partial writes pass while malformed values are
 * rejected. `strict` defaults to true; the document-mirror write passes
 * `strict: false` so AI-extracted values stay as lenient as pre-extraction.
 */
export const buildRecordShape = (
  fieldDefs: FieldDefinition[],
  options?: { strict?: boolean },
): z.ZodObject<Record<string, z.ZodTypeAny>> => {
  const strict = options?.strict ?? true;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of fieldDefs) {
    if (!def.enabled) continue;
    // Relations are graph edges (`links`) and rollups are view-computed
    // aggregates — neither lives in `data`.
    if (def.type === "relation" || def.type === "rollup") continue;
    shape[def.key] = zodForField(def, { strict });
  }
  return z.object(shape);
};

const TEXT_LIKE_TYPES: ReadonlySet<FieldDefinition["type"]> = new Set([
  "text",
  "url",
  "email",
  "select",
]);

export type RecordIdentity = {
  label: string;
  normalizedLabel: string;
  searchText: string;
};

/**
 * Derive a record's denormalized identity from its type's field definitions
 * and its `data`. Pure (no DB) so it is unit-testable in isolation; the
 * service writes the resulting `searchText` into `search_vector` via
 * `to_tsvector('simple', …)`.
 *
 *   - label: `labelOverride` if given (used by the document mirror = filename);
 *     else the value of the field flagged `isTitle`; else "".
 *   - normalizedLabel: `normalizeEntityName(label)`.
 *   - searchText: label plus the stringified values of every text/select field
 *     present in `data`, space-joined.
 */
export const computeRecordIdentity = (input: {
  fieldDefs: FieldDefinition[];
  data: Record<string, unknown>;
  labelOverride?: string | null;
}): RecordIdentity => {
  const { fieldDefs, data, labelOverride } = input;

  let label: string;
  if (labelOverride != null) {
    label = labelOverride;
  } else {
    const titleDef = fieldDefs.find((d) => d.isTitle);
    label = titleDef ? stringifyValue(data[titleDef.key]) : "";
  }

  const parts: string[] = [label];
  for (const def of fieldDefs) {
    if (!TEXT_LIKE_TYPES.has(def.type)) continue;
    const value = data[def.key];
    if (value == null) continue;
    parts.push(stringifyValue(value));
  }

  return {
    label,
    normalizedLabel: normalizeEntityName(label),
    searchText: parts.filter(Boolean).join(" ").trim(),
  };
};

/**
 * Coerce a JSONB attribute value to a flat string for the label / search
 * columns. Primitives stringify; arrays join their primitive members;
 * anything else (objects) contributes nothing — avoids `[object Object]`.
 */
const stringifyValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join(" ");
  }
  return "";
};
