import type { PageValue } from "../../../schemas/pages";

/**
 * Narrow arbitrary values to the JSON-only shape a page can render. Dates
 * become ISO strings (the renderer formats them through the viewer's locale);
 * anything else unrepresentable degrades to null rather than reaching the wire
 * as an opaque object.
 */
export const toPageValue = (value: unknown): PageValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toPageValue);
  if (typeof value === "object") {
    const mapped: Record<string, PageValue> = {};
    for (const [key, inner] of Object.entries(value)) {
      mapped[key] = toPageValue(inner);
    }
    return mapped;
  }
  return null;
};
