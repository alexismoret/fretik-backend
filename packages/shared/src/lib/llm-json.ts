/**
 * Pull a JSON object out of a possibly fenced/prosy LLM completion — the
 * shared defensive parse for calls whose provider pool gives no
 * structured-output guarantee (memory distillers, judges, extractors, the
 * free-form extract engine). Returns null when nothing parses — callers
 * validate with their own Zod/Ajv schema and degrade to a no-op.
 *
 * Handles, in order:
 *  - a ```json fenced block (even unclosed — a truncated completion) takes
 *    priority over prose around it;
 *  - the outermost `{…}` of the chosen source;
 *  - a one-shot repair for the most common small-model glitch observed live:
 *    the closing quote of the LAST string value dropped before the final `}`
 *    (`…"summary":"text.}`);
 *  - with `salvageTruncation` (caller saw `finishReason:"length"`): a JSON cut
 *    mid-array is trimmed back to the last complete `}` and re-closed —
 *    recovering the complete leading records instead of losing the response.
 */
export interface ParseLlmJsonOptions {
  /** Recover a completion cut off by the output cap: trim to the last
   * complete `}` and re-close the array/object. Off by default. */
  salvageTruncation?: boolean;
}

export const parseLlmJsonObject = (
  raw: string,
  options: ParseLlmJsonOptions = {},
): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)(?:```|$)/.exec(raw);
  const source = fenced?.[1]?.includes("{") ? fenced[1] : raw;
  const start = source.indexOf("{");
  if (start === -1) return null;
  const end = source.lastIndexOf("}");
  if (end > start) {
    const slice = source.slice(start, end + 1);
    const repaired = `${slice.slice(0, -1).trimEnd()}"}`;
    for (const candidate of [slice, repaired]) {
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through to the repaired candidate / salvage / null
      }
    }
  }
  if (!options.salvageTruncation) return null;
  // Trim-and-close ladder, longest salvage first: cut back to a complete `}`
  // and try closing an open array-of-objects, then a bare object. Bounded so a
  // pathological completion can't spin.
  let cursor = source.length;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const lastBrace = source.lastIndexOf("}", cursor - 1);
    if (lastBrace <= start) return null;
    const head = source.slice(start, lastBrace + 1);
    for (const closer of ["]}", "}"] as const) {
      try {
        return JSON.parse(`${head}${closer}`);
      } catch {
        // keep trimming
      }
    }
    cursor = lastBrace;
  }
  return null;
};
