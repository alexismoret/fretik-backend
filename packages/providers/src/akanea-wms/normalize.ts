import { isRecord } from "@fretik/shared/external-apps/json-access";

/**
 * Value converters between Akanea's wire conventions and ours.
 *
 * Xtent is a .NET stack whose JSON layer keeps three habits our manifest
 * types cannot express directly: booleans stored as `"O"`/`"N"`, dates
 * that may arrive either ISO or in the WCF `/Date(…)/` form, and numerics
 * that may arrive quoted. Everything the handlers read goes through the
 * helpers below so a serializer surprise degrades to a missing field
 * rather than a crashed action.
 */

/** `"O"` (oui) → true, `"N"` (non) → false. */
export const onToBool = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "O") return true;
  if (normalized === "N") return false;
  return undefined;
};

/** Inverse of `onToBool`, for values we send. */
export const boolToOn = (value: unknown): string | undefined => {
  if (typeof value !== "boolean") return undefined;
  return value ? "O" : "N";
};

const WCF_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

/**
 * Normalize an Akanea date.
 *
 * Xtent sends offset-less local timestamps (`2026-08-05T15:30:03`) — the
 * warehouse's own wall clock. Those are passed through UNTOUCHED: running
 * them through `Date` would read them in the Fretik server's timezone and
 * re-emit them in UTC, silently moving a dock appointment by hours.
 *
 * Only the WCF epoch form (`/Date(1735689600000+0100)/`) names a real
 * instant, so it is the only shape converted.
 */
export const akaneaDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const wcf = WCF_DATE.exec(trimmed);
  if (wcf === null) return trimmed;
  const epochMs = Number(wcf[1]);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : trimmed;
};

/** Number that tolerates a quoted (and comma-decimal) wire value. */
export const looseNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** String that tolerates a numeric/boolean wire value; empty → undefined. */
export const looseString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === "boolean") return value ? "O" : "N";
  return undefined;
};

/**
 * Read a documented (PascalCase) property from a response row, falling
 * back to a case-insensitive match. Which casing Xtent's serializer emits
 * is not pinned by the vendor documentation, and it differs between
 * deployments — matching both ways removes the guess.
 */
export const field = (row: unknown, name: string): unknown => {
  if (!isRecord(row)) return undefined;
  const direct = row[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

/** `field()` + the matching coercion, for the shapes handlers read most. */
export const strField = (row: unknown, name: string): string | undefined =>
  looseString(field(row, name));

export const numField = (row: unknown, name: string): number | undefined =>
  looseNumber(field(row, name));

export const boolField = (row: unknown, name: string): boolean | undefined =>
  onToBool(field(row, name));

export const dateField = (row: unknown, name: string): string | undefined =>
  akaneaDate(field(row, name));

/**
 * Drop the keys whose value is `undefined` so the generated Pydantic
 * models fall back to their own `None` defaults instead of receiving an
 * explicit `undefined` that JSON would erase anyway.
 */
export const compactRow = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};
