/**
 * Narrow what a tool's `execute` answered to the plain result object a test
 * asserts on.
 *
 * A tool may return a STREAM (`AsyncIterable`) as well as an object, so
 * `typeof result === "object"` — the check these suites used to inline — does
 * not actually establish "a result I can read fields from": an async iterable
 * passes it and then every field reads `undefined`, which shows up as a
 * confusing assertion failure three lines later rather than as "this tool
 * streamed". Excluding the iterator explicitly names the case.
 *
 * Generic so the tool's own result union survives: the caller keeps the fields
 * it is about to assert on instead of widening to `Record<string, unknown>`.
 */
export const asToolRecord = <T extends object>(
  tool: string,
  result: T | AsyncIterable<unknown> | string | number | null | undefined,
): T => {
  if (typeof result !== "object" || result === null) {
    throw new Error(`${tool} returned a non-object: ${JSON.stringify(result)}`);
  }
  if (Symbol.asyncIterator in result) {
    throw new Error(`${tool} returned a stream, not a result object`);
  }
  return result;
};
