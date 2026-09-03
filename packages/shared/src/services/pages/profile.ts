import type { PageFieldDescriptor, PageValue } from "../../schemas/pages";

/**
 * What a dataset's columns actually CONTAIN, one line each.
 *
 * One sample row was the whole probe until now, and one row does not describe
 * thirty columns: it says a field exists, never whether it is ever null, how
 * many distinct values it takes, or what those values are called. Every page
 * that shipped a filter over a status nobody uses, a chart grouped by a field
 * with two values, or a column of empty cells was designed from one row.
 *
 * The profile is computed over the rows the dataset RETURNED — its window —
 * and says so. A window is not the collection: `distinct` over the first
 * hundred rows of ten thousand is a floor, not a count, and `basis` next to the
 * sample's `rowCount`/`totalCount` is what lets the agent tell the difference
 * instead of trusting a number that looks exact.
 */

export interface PageFieldProfile {
  type?: string;
  label?: string;
  /** How many of the profiled rows hold nothing (null, undefined, ""). */
  nulls: number;
  /** Distinct non-null values seen — a floor when `basis` is "window". */
  distinct?: number;
  /** For numbers and dates, as they appear in the rows. */
  min?: string | number;
  max?: string | number;
  /** The most common values, biggest first — what a filter or a legend needs. */
  top?: { value: string; count: number }[];
  /** A few real values, for a field too varied to summarise. */
  examples?: string[];
  /** Where the numbers come from: the returned window, or the whole collection. */
  basis: "window" | "collection";
}

export interface ProfileRowsOptions {
  /** Field metadata from the dataset result, when it carries any. */
  fields?: readonly PageFieldDescriptor[];
  maxFields?: number;
  /** How many `top` values to keep per field. */
  top?: number;
  examples?: number;
}

const MAX_FIELDS = 24;
const TOP_VALUES = 8;
const EXAMPLES = 3;
/** Past this a field is free text, and a top-N of it teaches nothing. */
const HIGH_CARDINALITY_RATIO = 0.7;
const VALUE_CHARS = 60;

const isEmpty = (value: PageValue): boolean =>
  value === null || value === undefined || value === "";

const asRecord = (value: PageValue): Record<string, PageValue> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;

/** One value as a person reads it — an object becomes its shape, not its JSON. */
const asText = (value: PageValue): string => {
  if (typeof value === "string") {
    return value.length > VALUE_CHARS
      ? `${value.slice(0, VALUE_CHARS)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length.toString()} items]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).slice(0, 4).join(", ")}}`;
  }
  return "";
};

/** A date-looking string, so min/max mean something on it. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export const profileRows = (
  rows: readonly PageValue[],
  options: ProfileRowsOptions = {},
): Record<string, PageFieldProfile> => {
  const maxFields = options.maxFields ?? MAX_FIELDS;
  const topCount = options.top ?? TOP_VALUES;
  const exampleCount = options.examples ?? EXAMPLES;
  const meta = new Map(
    (options.fields ?? []).map((field) => [field.key, field]),
  );

  // Field order comes from the data, so the profile reads in the same order as
  // the rows the agent is looking at.
  const keys: string[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (record === null) continue;
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) keys.push(key);
    }
    if (keys.length >= maxFields) break;
  }

  const profile: Record<string, PageFieldProfile> = {};
  for (const key of keys.slice(0, maxFields)) {
    const counts = new Map<string, number>();
    let nulls = 0;
    let min: string | number | undefined;
    let max: string | number | undefined;

    for (const row of rows) {
      const value = asRecord(row)?.[key];
      if (value === undefined || isEmpty(value)) {
        nulls += 1;
        continue;
      }
      const text = asText(value);
      counts.set(text, (counts.get(text) ?? 0) + 1);
      if (typeof value === "number") {
        min = typeof min === "number" ? Math.min(min, value) : value;
        max = typeof max === "number" ? Math.max(max, value) : value;
      } else if (typeof value === "string" && ISO_DATE_RE.test(value)) {
        min = min === undefined || value < String(min) ? value : min;
        max = max === undefined || value > String(max) ? value : max;
      }
    }

    const field = meta.get(key);
    const distinct = counts.size;
    const filled = rows.length - nulls;
    const varied = filled > 0 && distinct / filled > HIGH_CARDINALITY_RATIO;
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));

    profile[key] = {
      ...(field?.type !== undefined ? { type: field.type } : {}),
      ...(field?.label !== undefined ? { label: field.label } : {}),
      nulls,
      ...(distinct > 0 ? { distinct } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      // Either the values are a vocabulary — the thing a filter is built from —
      // or the field is free text, and then a few examples is all that helps.
      ...(varied
        ? {
            examples: ranked.slice(0, exampleCount).map((entry) => entry.value),
          }
        : { top: ranked.slice(0, topCount) }),
      basis: "window",
    };
  }
  return profile;
};
