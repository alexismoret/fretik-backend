import { describe, expect, test } from "bun:test";
import {
  hashPageDataRequest as hash,
  publicPageDataCacheKey,
} from "../../src/services/pages/public-cache";

/**
 * The public page's cache key.
 *
 * A published page is a link anyone can open, so its data route is cached — and
 * a cache key that misses ANY part of the request serves one viewer another's
 * rows. That is the whole risk here: variables were the only thing hashed, so
 * two viewers on different pages of the same table, or on opposite sort
 * directions, asked the same URL with the same variables.
 */

describe("hashPageDataRequest", () => {
  test("key order never splits an entry", () => {
    expect(hash({ variables: { a: 1, b: 2 } })).toBe(
      hash({ variables: { b: 2, a: 1 } }),
    );
    expect(
      hash({ variables: {}, queries: { t: { page: 2, sortBy: "name" } } }),
    ).toBe(
      hash({ variables: {}, queries: { t: { sortBy: "name", page: 2 } } }),
    );
  });

  test("every page of a table gets its own entry", () => {
    const base = { variables: { month: "2026-08" } };
    const page1 = hash({ ...base, queries: { deals: { page: 1 } } });
    const page2 = hash({ ...base, queries: { deals: { page: 2 } } });
    expect(page1).not.toBe(page2);
  });

  test("ordering, page size and dataset subset each move the key", () => {
    const base = { variables: {} };
    const keys = new Set([
      hash(base),
      hash({ ...base, queries: { deals: { sortBy: "amount" } } }),
      hash({
        ...base,
        queries: { deals: { sortBy: "amount", sortDir: "asc" } },
      }),
      hash({
        ...base,
        queries: { deals: { sortBy: "amount", sortDir: "desc" } },
      }),
      hash({ ...base, queries: { deals: { pageSize: 50 } } }),
      hash({ ...base, datasetIds: ["deals"] }),
    ]);
    expect(keys.size).toBe(6);
  });

  test("a different dataset asking the same window is a different entry", () => {
    expect(hash({ variables: {}, queries: { a: { page: 2 } } })).not.toBe(
      hash({ variables: {}, queries: { b: { page: 2 } } }),
    );
  });

  test("the dataset subset is order-insensitive — it is a set", () => {
    expect(hash({ variables: {}, datasetIds: ["a", "b"] })).toBe(
      hash({ variables: {}, datasetIds: ["b", "a"] }),
    );
  });

  test("an absent query and an empty one agree", () => {
    expect(hash({ variables: { q: "x" } })).toBe(
      hash({ variables: { q: "x" }, queries: undefined }),
    );
  });

  test("the key stays namespaced under its token", () => {
    expect(publicPageDataCacheKey("tok", hash({ variables: {} }))).toStartWith(
      "page:pub:tok:data:",
    );
  });
});
