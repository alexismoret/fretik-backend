/**
 * Serialises a thrown value to a structured diagnostic summary. Captures
 * the constructor name, message, `cause` chain (the AI SDK wraps the
 * inner provider error in it), and optional provider-specific fields
 * (`responseBody`, `statusCode`, `url`) so logs distinguish a
 * client-side AbortSignal timeout from a Zod parse failure from a
 * provider 5xx without guessing.
 *
 * We slice long fields to 3000 chars — enough to see the JSON that
 * failed parsing, capped so a 30-page error dump doesn't swamp logs.
 *
 * Shared by the pre-extract service and the structured-extract engine
 * (moved out of `services/pre-extract/extract.ts` verbatim).
 */
export const describeLlmError = (err: unknown): string => {
  if (!(err instanceof Error)) return `(non-Error) ${String(err)}`;
  const parts: string[] = [
    `name=${err.name}`,
    `message=${err.message.slice(0, 3000)}`,
  ];
  if (err.cause) {
    if (err.cause instanceof Error) {
      parts.push(
        `cause.name=${err.cause.name}`,
        `cause.message=${err.cause.message.slice(0, 3000)}`,
      );
    } else {
      // Cause is not an Error — JSON-stringify unconditionally so we
      // never hit the `[object Object]` default toString that would
      // make the log useless. `JSON.stringify` tolerates primitives,
      // arrays, and plain objects; returns `undefined` on BigInt /
      // circular refs which we coalesce to an empty marker.
      const raw = JSON.stringify(err.cause) ?? "(uncoercible)";
      parts.push(`cause=${raw.slice(0, 3000)}`);
    }
  }
  const extra = err as unknown as Record<string, unknown>;
  if (typeof extra.statusCode === "number") {
    parts.push(`status=${extra.statusCode}`);
  }
  if (typeof extra.url === "string") {
    parts.push(`url=${extra.url}`);
  }
  if (typeof extra.responseBody === "string") {
    const body = extra.responseBody;
    parts.push(
      `responseBody=${body.slice(0, 3000)}${body.length > 3000 ? "…" : ""}`,
    );
  }
  // Zod validation failures on `generateText` attach the parsed value
  // that failed. Pull it out explicitly so we see the full rejected
  // object (truncated by the slice above), not just a fragment.
  if ("value" in extra && extra.value !== undefined) {
    const valueStr =
      typeof extra.value === "string"
        ? extra.value
        : JSON.stringify(extra.value);
    parts.push(
      `value=${valueStr.slice(0, 3000)}${valueStr.length > 3000 ? "…" : ""}`,
    );
  }
  return parts.join(" | ");
};
