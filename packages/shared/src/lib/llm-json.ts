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
 *  - a bracket rebalance for the second glitch observed live (deepseek digest,
 *    2026-08-05, ~1/40 at temperature 0): a stray closer with the content
 *    intact (`…"summary":"text."]}`). String-aware; only DROPS unmatched
 *    closers and refuses open strings or unclosed brackets — rebalancing must
 *    never dress a truncation up as a complete parse;
 *  - with `salvageTruncation` (caller saw `finishReason:"length"`): a JSON cut
 *    mid-array is trimmed back to the last complete `}` and re-closed —
 *    recovering the complete leading records instead of losing the response.
 */
export interface ParseLlmJsonOptions {
  /** Recover a completion cut off by the output cap: trim to the last
   * complete `}` and re-close the array/object. Off by default. */
  salvageTruncation?: boolean;
}

/**
 * Rebalance brackets over a string-intact slice by DROPPING closers that
 * match nothing. Never appends missing closers and refuses an open string or
 * unclosed bracket — an incomplete document is a truncation, and only the
 * opt-in salvage path may accept one.
 */
const rebalanceBrackets = (src: string): string | null => {
  let out = "";
  const stack: ("{" | "[")[] = [];
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const ch of src) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === (ch === "}" ? "{" : "[")) {
        stack.pop();
        out += ch;
      } else {
        changed = true;
      }
      continue;
    }
    out += ch;
  }
  if (inString || stack.length > 0) return null;
  return changed ? out : null;
};

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
    const rebalanced = rebalanceBrackets(slice);
    for (const candidate of [
      slice,
      repaired,
      ...(rebalanced !== null ? [rebalanced] : []),
    ]) {
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through to the next candidate / salvage / null
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
