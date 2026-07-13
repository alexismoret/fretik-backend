/**
 * Pull a JSON object out of a possibly fenced/prosy LLM completion — the
 * shared defensive parse for utility-tier calls whose provider pool gives no
 * structured-output guarantee (memory distillers, judges, extractors).
 * Includes a one-shot repair for the most common small-model glitch observed
 * live: the closing quote of the LAST string value dropped before the final
 * `}` (`…"summary":"text.}`). Returns null when nothing parses — callers
 * validate with their own Zod schema and degrade to a no-op.
 */
export const parseLlmJsonObject = (raw: string): unknown => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  const repaired = `${slice.slice(0, -1).trimEnd()}"}`;
  for (const candidate of [slice, repaired]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to the repaired candidate / null
    }
  }
  return null;
};
