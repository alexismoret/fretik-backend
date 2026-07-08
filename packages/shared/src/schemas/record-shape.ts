import { z } from "zod";
import type { FieldDefinition } from "../db/schema";
import {
  defaultCurrencyCode,
  fieldOptions,
  hasTime,
  isFreeform,
  isMultiMember,
  MAPBOX_FEATURE_TYPES,
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
 *   - date                → z.string() YYYY-MM-DD, or ISO 8601 when
 *                           `config.hasTime` (a single date type, Notion-style)
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
    case "location": {
      // The geocoded place object. Lenient callers (the LLM / pre-extract) may
      // emit a bare address string — coercion wraps it into `{ address }` and
      // the coords are filled server-side by the geocoder.
      const place = z.looseObject({
        address: z.string(),
        lat: z.number().nullish(),
        lng: z.number().nullish(),
        mapboxId: z.string().nullish(),
        // Unrecognized Mapbox type → undefined (dropped), never a hard failure.
        featureType: z.enum(MAPBOX_FEATURE_TYPES).nullish().catch(undefined),
        // Area bounding box `[minLon, minLat, maxLon, maxLat]`; UI-captured.
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .nullish(),
      });
      const base = strict ? place : z.union([z.string(), place]);
      return base.nullish().describe(description);
    }
    case "relation":
    case "rollup":
    case "unique_id":
    case "created_time":
    case "last_edited_time":
    case "created_by":
    case "last_edited_by": {
      // None is written through `data`: relations live in the `links` graph,
      // rollups + system properties are computed from the registry, and
      // `unique_id` is filled by its sequence. `buildRecordShape` skips them;
      // this keeps the switch exhaustive.
      return z.unknown().nullish().describe(description);
    }
    case "boolean": {
      return z.boolean().nullish().describe(description);
    }
    case "date": {
      // One date type: `config.hasTime` decides whether a time component is
      // expected (ISO 8601 datetime) or a calendar date only (YYYY-MM-DD).
      if (hasTime(def.config)) {
        return z
          .string()
          .regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/,
            "Expected ISO 8601 datetime",
          )
          .nullish()
          .describe(
            `${description} Format: ISO 8601 datetime (e.g. 2025-01-15T10:30:00Z).`,
          );
      }
      return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
        .nullish()
        .describe(
          `${description} Format: YYYY-MM-DD (calendar date only, no time component).`,
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

/** Up to 8 option values as `[a, b, …]`; "…" marks a truncated list. */
const optionList = (def: FieldDefinition): string => {
  const values = optionValues(def);
  const shown = values.slice(0, 8);
  if (values.length > shown.length) shown.push("…");
  return `[${shown.join(", ")}]`;
};

/**
 * One compact "error that teaches" line for a field: its key, type, and the
 * shape a value must take — with the valid option VALUES for select fields, so
 * the model copies them instead of inventing (the value must come from the
 * schema, never the model's imagination). Fed into `validateRecordData`'s
 * failure message so a weak model self-corrects in one step. Generalist: no
 * industry vocabulary, examples are format placeholders.
 */
export const describeFieldExpectation = (def: FieldDefinition): string => {
  const key = def.key;
  switch (def.type) {
    case "text":
    case "markdown":
    case "phone":
      return `${key} (${def.type}): a string`;
    case "email":
      return `${key} (email): an email, e.g. "name@example.com"`;
    case "url":
      return `${key} (url): a URL, e.g. "https://example.com"`;
    case "number": {
      const { min, max } = numberBounds(def.config);
      const range =
        typeof min === "number" && typeof max === "number"
          ? ` between ${min.toString()} and ${max.toString()}`
          : typeof min === "number"
            ? ` ≥ ${min.toString()}`
            : typeof max === "number"
              ? ` ≤ ${max.toString()}`
              : "";
      return `${key} (number): a quoted number${range}, e.g. "1500"`;
    }
    case "rating":
      return `${key} (rating): an integer 0–${ratingMax(def.config).toString()}`;
    case "boolean":
      return `${key} (boolean): "true" or "false"`;
    case "date":
      return hasTime(def.config)
        ? `${key} (date): ISO 8601 datetime, e.g. "2025-01-15T10:30:00Z"`
        : `${key} (date): "YYYY-MM-DD", e.g. "2025-01-31"`;
    case "select":
      return optionValues(def).length > 0
        ? `${key} (select): one of ${optionList(def)}`
        : `${key} (select): a string`;
    case "multi_select":
      return optionValues(def).length > 0 && !isFreeform(def.config)
        ? `${key} (multi_select): a list from ${optionList(def)}`
        : `${key} (multi_select): a list of strings`;
    case "member":
      return isMultiMember(def.config)
        ? `${key} (member): a list of user ids`
        : `${key} (member): a user id`;
    case "money":
      return `${key} (money): the string "1500 EUR" (tools), or the object { "amount": 1500, "currencyCode": "EUR" } (Python SDK / API). NOT "currency" — the key is "currencyCode".`;
    case "location":
      return `${key} (location): an address string, e.g. "10 Downing St, London" (coordinates are added server-side)`;
    case "unique_id":
      return `${key} (unique_id): auto-assigned reference, read-only`;
    case "relation":
    case "rollup":
    case "created_time":
    case "last_edited_time":
    case "created_by":
    case "last_edited_by":
      return `${key} (${def.type}): not set through record data`;
    default: {
      const _exhaustive: never = def.type;
      return _exhaustive;
    }
  }
};

/**
 * Normalize a field value to the primitive its column expects, BEFORE
 * `validateRecordData` runs Zod. Weak models slip on the JSON primitive — a
 * phone as a number, a count as a string, a bool as `"true"` — which would
 * hard-fail with `expected string, received number` and trigger a retry loop.
 *
 * We coerce ONLY when the fix is logical — a representational slip on a value
 * that still makes sense for the column (a phone IS text, a count IS numeric).
 * A SEMANTIC mismatch (a number where an email/url belongs) is left untouched
 * so Zod rejects it with its actionable, field-scoped message and the agent
 * corrects the actual value. Format rules (email, URL, date regex, number
 * bounds) stay with Zod, so `strict` semantics are unchanged.
 *
 * Not `z.coerce`: `z.coerce.boolean()` is `Boolean(x)` so `"false"` → `true`;
 * `z.coerce.number()` maps `""`/`null` → `0`; `z.coerce.string()` yields
 * `"[object Object]"`. An explicit, logical pre-pass is safer.
 */
export const coerceRecordValue = (
  def: FieldDefinition,
  rawValue: unknown,
): unknown => {
  if (rawValue == null) return rawValue;
  // Weak models wrap a scalar in a one-element array when the tool param also
  // accepts a list (`value: string | string[]`). For a non-list field, unwrap
  // it — `["Acme"]` on a text field means `"Acme"`. List fields (multi_select,
  // multi-member) keep their array.
  const value =
    !isListField(def) && Array.isArray(rawValue) && rawValue.length === 1
      ? rawValue[0]
      : rawValue;
  if (value == null) return value;
  switch (def.type) {
    // Free-text columns: a number/boolean is meant as its text form.
    case "text":
    case "markdown":
    case "phone": {
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }
    case "url": {
      // A scheme-less host ("example.com") is a URL missing its scheme — a
      // representational slip, not a wrong value. Prepend https://; anything
      // that still isn't a URL stays for Zod (strict) to reject.
      if (typeof value !== "string") return value;
      const s = value.trim();
      if (s === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
      return `https://${s}`;
    }
    case "date": {
      if (typeof value !== "string") return value;
      // With time: ISO 8601 UTC (accept a date-only value → midnight, a zone
      // offset, or a bare local datetime → canonical `…Z`). Without time:
      // YYYY-MM-DD (accept a datetime → its date part, or any parseable form).
      // The unparseable is left for Zod's regex to flag.
      return hasTime(def.config) ? toIsoDateTime(value) : toCalendarDate(value);
    }
    case "number":
    case "rating": {
      if (typeof value === "string") {
        // Drop spaces and a leading currency symbol ("€1 500" → 1500); leave
        // grouping commas alone (locale-ambiguous) for Zod to flag if invalid.
        const cleaned = value
          .trim()
          .replace(/[\s ]+/g, "")
          .replace(/^[^\d+.-]+/, "");
        if (cleaned === "") return value;
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : value;
      }
      return value;
    }
    case "boolean": {
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
        if (v === "false" || v === "0" || v === "no" || v === "n") return false;
        return value;
      }
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    case "select": {
      // Map a human label or a different casing onto the canonical option
      // value ("Gold" / "gold" → the option whose value is `gold`).
      const options = fieldOptions(def.config);
      if (options.length === 0) {
        return typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : value;
      }
      return matchOption(value, options);
    }
    case "multi_select": {
      // Accept a bare scalar as a one-element list; map each member onto its
      // canonical option value (or stringify when the field is freeform).
      const options = fieldOptions(def.config);
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((el) =>
        options.length > 0
          ? matchOption(el, options)
          : typeof el === "number" || typeof el === "boolean"
            ? String(el)
            : el,
      );
    }
    case "money": {
      // The tools pass money as a string ("1500 EUR"); the SDK/API pass the
      // { amount, currencyCode } object. Parse the string; leave the object
      // (and anything unparseable) for Zod.
      if (typeof value === "string") {
        return (
          parseMoneyString(value, defaultCurrencyCode(def.config)) ?? value
        );
      }
      return value;
    }
    case "member": {
      // A multi-member field is a list: a bare member id becomes a one-element
      // list (mirrors multi_select). A single-member field keeps the bare id —
      // the top-level unwrap already reduced a `["id"]` to the scalar.
      if (isMultiMember(def.config)) {
        return Array.isArray(value) ? value : [value];
      }
      return value;
    }
    case "location": {
      // Tools / pre-extract pass a plain address string; the SDK/UI pass the
      // full `{ address, lat, lng, … }` object. Wrap the string; the geocoder
      // fills the coordinates + feature type before the write.
      if (typeof value === "string") return { address: value };
      return value;
    }
    // Semantic value (email) or structured/non-data field: leave to Zod.
    case "email":
    case "relation":
    case "rollup":
    case "unique_id":
    case "created_time":
    case "last_edited_time":
    case "created_by":
    case "last_edited_by": {
      return value;
    }
    default: {
      // Exhaustiveness guard: a field type added to FIELD_TYPES without a
      // coercion branch is a COMPILE error here — not a silent `undefined` that
      // would clobber the value on write (this fn returns `unknown`, so TS does
      // not otherwise flag a missing case).
      const _exhaustive: never = def.type;
      return _exhaustive;
    }
  }
};

/**
 * Parse a money string into `{ amount, currencyCode }`. Pulls the first number
 * and the first 3-letter code ("1500 EUR", "EUR 1500", or "1500" + the field's
 * default). Returns undefined when neither an amount nor a currency resolves —
 * the caller then leaves the raw value for Zod to reject.
 */
const parseMoneyString = (
  raw: string,
  fallbackCurrency: string | undefined,
): { amount: number; currencyCode: string } | undefined => {
  const numMatch = raw.match(/-?\d+(?:[.,]\d+)?/);
  if (!numMatch) return undefined;
  const amount = Number(numMatch[0].replace(",", "."));
  if (!Number.isFinite(amount)) return undefined;
  const codeMatch = raw.match(/[A-Za-z]{3}/);
  const currencyCode = codeMatch
    ? codeMatch[0].toUpperCase()
    : fallbackCurrency;
  if (!currencyCode) return undefined;
  return { amount, currencyCode };
};

/** A field whose value is a list: multi_select, or a member field set to multiple. */
const isListField = (def: FieldDefinition): boolean =>
  def.type === "multi_select" ||
  (def.type === "member" && isMultiMember(def.config));

/** Map a value onto the option whose value or label it matches (case-insensitive). */
const matchOption = (
  value: unknown,
  options: { value: string; label: string }[],
): unknown => {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return value;
  }
  const lc = String(value).trim().toLowerCase();
  const hit = options.find(
    (o) => o.value.toLowerCase() === lc || o.label.toLowerCase() === lc,
  );
  return hit ? hit.value : String(value).trim();
};

/** Reduce any ISO-ish or parseable value to a `YYYY-MM-DD` calendar date. */
const toCalendarDate = (raw: string): string => {
  const s = raw.trim();
  const prefix = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (prefix) return `${prefix[1]}-${prefix[2]}-${prefix[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString().slice(0, 10);
};

/** Normalize a date / datetime string to canonical ISO 8601 UTC (`…Z`). */
const toIsoDateTime = (raw: string): string => {
  const s = raw.trim();
  // Date only → midnight UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
};

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
    // Relations are graph edges (`links`), rollups are view-computed aggregates,
    // and `unique_id` is sequence-filled — none is written through `data`.
    if (
      def.type === "relation" ||
      def.type === "rollup" ||
      def.type === "unique_id" ||
      def.type === "created_time" ||
      def.type === "last_edited_time" ||
      def.type === "created_by" ||
      def.type === "last_edited_by"
    )
      continue;
    shape[def.key] = zodForField(def, { strict });
  }
  return z.object(shape);
};

// Field types whose values feed the search text. Kept in lockstep with the same
// set in `services/object-records/field-data.ts` (the background recompute).
const TEXT_LIKE_TYPES: ReadonlySet<FieldDefinition["type"]> = new Set([
  "text",
  "markdown",
  "url",
  "email",
  "phone",
  "select",
  "multi_select",
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
