import type { FieldDefinition } from "../../db/schema";
import type {
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema/field-types";
import {
  defaultCurrencyCode,
  NON_WRITABLE_FIELD_TYPES,
} from "../../db/schema/field-types";
import type { ParamSpec } from "../../external-apps/manifest-schema";
import type { SyncFieldMapping } from "../../schemas/collection-sync";
import { coerceRecordValue } from "../../schemas/record-shape";
import { canonicalHash } from "../approvals/hash";
import { resolveResultPath } from "./result-path";

/**
 * One upstream row → the `data` map of one record, plus the hash that decides
 * whether it is worth writing.
 *
 * Pure on purpose, and the reason the engine is affordable. On a 10 000-row
 * collection refreshed hourly, the hash is what turns "10 000 UPDATEs, 10 000
 * `domain_events`, 10 000 record-card re-embeddings, 10 000 workflow trigger
 * candidates" into "the twelve rows that changed". Everything downstream of a
 * write is expensive; not writing is free.
 *
 * Two rules the projection never breaks:
 *  - it writes ONLY the keys the source owns (its `fieldMapping`), so a user's
 *    local column on a synced collection survives every run;
 *  - it never writes a DERIVED field — a formula is a `GENERATED … STORED`
 *    column Postgres physically refuses, a rollup and a relation live
 *    elsewhere, and a `unique_id` comes from its sequence.
 */

export interface ProjectedRow {
  /** Field key → value, ready for `bulkCreate`/`bulkUpdate` (merge). */
  data: Record<string, unknown>;
  /** sha256 of the canonical projected values — a change detector, not a key. */
  hash: string;
}

/**
 * Walk a dot path into one upstream row. The same grammar a `resultPath` uses,
 * because a person who learnt one has learnt the other.
 */
export const readPath = (row: unknown, path: string): unknown =>
  resolveResultPath(row, path);

/** Field types a sync may fill. Everything else is derived or system-owned. */
export const isSyncFillableType = (type: FieldDefinitionType): boolean =>
  !NON_WRITABLE_FIELD_TYPES.has(type);

export const projectRow = (input: {
  row: unknown;
  mapping: readonly SyncFieldMapping[];
  fields: readonly FieldDefinition[];
}): ProjectedRow => {
  const byKey = new Map(input.fields.map((field) => [field.key, field]));
  const data: Record<string, unknown> = {};
  for (const entry of input.mapping) {
    const field = byKey.get(entry.fieldKey);
    if (field === undefined || !isSyncFillableType(field.type)) continue;
    // Absent upstream is `null`, not "leave it alone": a value that disappeared
    // must clear its column, or a stale figure outlives the fact it described.
    const raw = readPath(input.row, entry.path) ?? null;
    data[entry.fieldKey] =
      raw === null ? null : coerceRecordValue(field, normalize(field, raw));
  }
  return { data, hash: hashProjection(data) };
};

/**
 * The hash of a projection.
 *
 * Over the COERCED values, deliberately: an upstream that answers `"42"` today
 * and `42` tomorrow for the same number column has not changed anything a
 * person can see, and hashing the raw answer would rewrite the row (and re-fire
 * every workflow watching it) for a JSON formatting difference.
 *
 * `canonicalHash` sorts keys at every level, so a provider reordering its
 * response object is not a change either. `.slice(0, 64)` matches
 * `record_sync_state.content_hash`'s width — sha256 hex is exactly 64, so the
 * slice is a guard on the column rather than a shortening.
 */
export const hashProjection = (data: Record<string, unknown>): string =>
  canonicalHash(data).slice(0, 64);

/**
 * Representational fixes `coerceRecordValue` does not cover, because they only
 * arise when the writer is a third-party API rather than a person or a model.
 */
const normalize = (field: FieldDefinition, value: unknown): unknown => {
  const isObject = typeof value === "object" && value !== null;
  switch (field.type) {
    case "date": {
      // Epoch timestamps: a number is never a date to `coerceRecordValue` (a
      // person types a date), but half the APIs here answer in epochs. The
      // discriminator is magnitude — 1e11 seconds is the year 5138, so anything
      // above it is milliseconds and anything below is seconds.
      if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value > 1e11 ? value : value * 1000).toISOString();
      }
      return value;
    }
    case "money": {
      // A bare amount with the column's own currency. Two upstream paths
      // (`amount` + `currency`) are mapped as two entries and the object form
      // passes straight through to Zod.
      if (typeof value === "number") {
        return {
          amount: value,
          currencyCode: defaultCurrencyCode(field.config) ?? "EUR",
        };
      }
      return value;
    }
    case "text":
    case "markdown": {
      // A nested object in a text column is the shape a user maps when they
      // wanted the whole thing. JSON is the only honest rendering of it.
      return isObject ? JSON.stringify(value) : value;
    }
    default: {
      // An object or array in a scalar column cannot be represented, and a
      // whole row must not fail over one unmappable column — `record_sync_state`
      // is per RECORD, so a row-level failure would take the other 40 columns
      // down with it. The column clears, the rest lands, and the preview is
      // where a bad mapping is supposed to be caught.
      if (
        isObject &&
        field.type !== "location" &&
        field.type !== "multi_select"
      ) {
        return null;
      }
      return value;
    }
  }
};

// ── Type inference ────────────────────────────────────────────────────

export interface InferredFieldType {
  type: FieldDefinitionType;
  config?: FieldDefinitionConfig;
}

const NAME_HINTS: [RegExp, FieldDefinitionType][] = [
  [/(^|_)(url|link|website|href)$/i, "url"],
  [/(^|_)(phone|tel|mobile|fax)$/i, "phone"],
  [/(^|_)e?mail$/i, "email"],
];

/**
 * `ParamSpec` → field type, the table of plan §3.6.
 *
 * `undefined` means "not mappable as one column": an object is flattened one
 * level by the caller (`address.city` → a field per sub-path) and an array of
 * objects is a second collection, not a cell. Refusing here is what keeps a
 * jsonb bag from appearing in a system whose whole value is typed columns.
 *
 * `name` is the last path segment when the caller has one. It only ever
 * PROPOSES url / phone / email over `text` — a suggestion the preview shows and
 * the user overrides, never a decision made behind them.
 */
export const inferFieldTypeFromParamSpec = (
  spec: ParamSpec,
  name?: string,
): InferredFieldType | undefined => {
  switch (spec.type) {
    case "string": {
      const hinted = name === undefined ? undefined : hintFromName(name);
      return { type: hinted ?? "text" };
    }
    case "integer":
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "email":
      return { type: "email" };
    case "date":
      return { type: "date", config: { hasTime: false } };
    case "datetime":
      return { type: "date", config: { hasTime: true } };
    case "enum":
      return { type: "select", config: { options: toOptions(spec.values) } };
    case "array": {
      const items = spec.items;
      if (items === undefined)
        return { type: "multi_select", config: { freeform: true } };
      if (items.type === "enum") {
        return {
          type: "multi_select",
          config: { options: toOptions(items.values), freeform: true },
        };
      }
      if (items.type === "string" || items.type === "email") {
        return { type: "multi_select", config: { freeform: true } };
      }
      // An array of objects or of numbers is not a cell.
      return undefined;
    }
    case "object":
      return undefined;
    default: {
      const exhaustive: never = spec.type;
      return exhaustive;
    }
  }
};

const hintFromName = (name: string): FieldDefinitionType | undefined =>
  NAME_HINTS.find(([pattern]) => pattern.test(name))?.[1];

const toOptions = (
  values: string[] | undefined,
): { value: string; label: string }[] =>
  (values ?? []).map((value) => ({ value, label: value }));

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_LIKE = /^https?:\/\/\S+$/i;

/**
 * Field type from sampled VALUES — the MCP and Directus path, where the answer
 * carries no schema at all (`returns: {fields: {}}`).
 *
 * The timidity of `inferExternalFields` is kept and matters more here, because
 * a page's wrong guess costs a formatter and this one costs a COLUMN TYPE: a
 * `number` column that meets its first alphanumeric reference is a row that
 * stops landing. So a type is claimed only when every non-empty sample agrees,
 * and everything mixed, nested or entirely empty falls back to `text`, which
 * accepts whatever arrives and can be narrowed by hand afterwards.
 */
export const inferFieldTypeFromSamples = (
  values: readonly unknown[],
): InferredFieldType => {
  const kinds = new Set<string>();
  let sawArray = false;
  for (const value of values) {
    // A null says nothing about the type and must not make it `text` — a column
    // empty in row one and numeric in row two is numeric.
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      sawArray = true;
      kinds.add(
        value.every((entry) => typeof entry === "string") ? "strings" : "mixed",
      );
      continue;
    }
    if (typeof value === "number") kinds.add("number");
    else if (typeof value === "boolean") kinds.add("boolean");
    else if (typeof value === "string") {
      kinds.add(
        ISO_DATETIME.test(value)
          ? "datetime"
          : CALENDAR_DATE.test(value)
            ? "date"
            : EMAIL_LIKE.test(value)
              ? "email"
              : URL_LIKE.test(value)
                ? "url"
                : "text",
      );
    } else kinds.add("mixed");
  }

  if (sawArray) {
    return kinds.size === 1 && kinds.has("strings")
      ? { type: "multi_select", config: { freeform: true } }
      : { type: "text" };
  }
  if (kinds.size !== 1) return { type: "text" };
  const [only] = [...kinds];
  switch (only) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "date", config: { hasTime: false } };
    case "datetime":
      return { type: "date", config: { hasTime: true } };
    case "email":
      return { type: "email" };
    case "url":
      return { type: "url" };
    default:
      return { type: "text" };
  }
};
