/**
 * Type-safe accessors for dynamically-shaped JSON — used by provider
 * mappers to read external API (Microsoft Graph, …) responses and the
 * agent's argument objects without `any` or `as` casts.
 *
 * Every helper narrows at runtime via type predicates, so the rest of the
 * external-apps code stays fully typed.
 */

/** True when `value` is a plain object (record), not an array or null. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a property from an unknown value; `undefined` if not a record. */
export const prop = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

/** Walk a nested path; `undefined` as soon as the chain breaks. */
export const path = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    current = prop(current, key);
    if (current === undefined) return undefined;
  }
  return current;
};

/** Coerce to `string`, or `undefined`. */
export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Coerce to `string`, with a fallback (default `""`). */
export const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** Coerce to `number`, or `undefined`. */
export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Coerce to `number`, with a fallback (default `0`). */
export const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Coerce to `boolean`, with a fallback (default `false`). */
export const bool = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

/** Coerce to an array of unknown; empty array when not an array. */
export const arr = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Coerce to an array of strings, dropping non-string elements. */
export const strArray = (value: unknown): string[] =>
  arr(value).filter((item): item is string => typeof item === "string");
