/**
 * Bounded-parallel map preserving input order. Runs at most `limit`
 * `fn` invocations concurrently, writing each result back at its input
 * index so the output array mirrors `items` regardless of completion
 * order. Shared by the chunked aux-LLM engines (`structured-extract`,
 * `prose-transform`) so a document's chunks fan out without a fan-out
 * primitive per engine.
 */
export const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await fn(item);
      }
    },
  );
  await Promise.all(workers);
  return results;
};
