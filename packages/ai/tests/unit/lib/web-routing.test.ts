import { beforeEach, describe, expect, test } from "bun:test";
import { webCacheKey, withWebCache } from "../../../src/lib/web/cache";
import {
  filterHits,
  harvestImages,
  searchWithFallback,
  type SearchAdapters,
} from "../../../src/lib/web/routing";
import type {
  WebSearchOutcome,
  WebSearchRequest,
} from "../../../src/lib/web/types";
import { resetRedisDouble } from "../../lib/redis-double";

/**
 * Search routing and the result cache: which provider serves a call, what
 * happens when it does not, and what the cache is allowed to remember.
 *
 * The adapters are passed IN rather than mocked. Module mocking is
 * order-dependent in this suite by construction — a sibling file that imports
 * the façade first links the real adapters and no later `mock.module` can
 * unbind them, which is exactly how the first version of this file passed
 * alone and called `api.perplexity.ai` for real in the full run.
 */

type Behaviour = "ok" | "empty" | "throw";

const hit = (provider: string) => ({
  title: `${provider} hit`,
  url: `https://${provider}.test/a`,
  content: "body",
  favicon: null,
  publishedDate: null,
});

const calls: string[] = [];

const fakeAdapters = (
  perplexity: Behaviour,
  parallel: Behaviour,
): SearchAdapters => {
  const make = (provider: string, behaviour: Behaviour) => async () => {
    calls.push(provider);
    if (behaviour === "throw") throw new Error(`${provider} is down`);
    return {
      results: behaviour === "empty" ? [] : [hit(provider)],
      images: [],
      cost: { costUsd: 0.005, metadata: { provider } },
    };
  };
  return {
    perplexity: make("perplexity", perplexity),
    parallel: make("parallel", parallel),
  };
};

const ENV_KEYS = [
  "PERPLEXITY_API_KEY",
  "PARALLEL_API_KEY",
  "AI_WEB_SEARCH_PROVIDER",
  "AI_WEB_SEARCH_FALLBACK",
] as const;

const withEnv = async (
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> => {
  const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const key of ENV_KEYS) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const BOTH_KEYS = {
  PERPLEXITY_API_KEY: "pplx-test",
  PARALLEL_API_KEY: "par-test",
} as const;

const request: WebSearchRequest = { queries: ["a query"], depth: "standard" };

/** The message of the error a call rejected with, or `null` if it resolved. */
const rejectionOf = async (
  run: () => Promise<unknown>,
): Promise<string | null> => {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

beforeEach(() => {
  calls.length = 0;
  resetRedisDouble();
});

describe("searchWithFallback", () => {
  test("serves from the configured provider and does not touch the other", async () => {
    await withEnv(BOTH_KEYS, async () => {
      const result = await searchWithFallback(
        request,
        fakeAdapters("ok", "ok"),
      );
      expect(result.provider).toBe("perplexity");
      expect(calls).toEqual(["perplexity"]);
    });
  });

  test("falls back to the other provider when the primary throws", async () => {
    await withEnv(BOTH_KEYS, async () => {
      const result = await searchWithFallback(
        request,
        fakeAdapters("throw", "ok"),
      );
      expect(result.provider).toBe("parallel");
      expect(calls).toEqual(["perplexity", "parallel"]);
      expect(result.cost.metadata.fallbackFrom).toBe("perplexity");
    });
  });

  /**
   * Zero results is a failure mode as real as an exception — a provider having
   * a bad moment on one phrasing — and the agent cannot tell them apart, so
   * neither does the router.
   */
  test("falls back when the primary answers nothing", async () => {
    await withEnv(BOTH_KEYS, async () => {
      const result = await searchWithFallback(
        request,
        fakeAdapters("empty", "ok"),
      );
      expect(result.provider).toBe("parallel");
      expect(result.cost.metadata.reason).toBe("no results");
    });
  });

  test("an operator can switch the primary with one env var", async () => {
    await withEnv(
      { ...BOTH_KEYS, AI_WEB_SEARCH_PROVIDER: "parallel" },
      async () => {
        const result = await searchWithFallback(
          request,
          fakeAdapters("ok", "ok"),
        );
        expect(result.provider).toBe("parallel");
        expect(calls).toEqual(["parallel"]);
      },
    );
  });

  /**
   * `PARALLEL_API_KEY` is required for `webFetch` anyway, so "Parallel key, no
   * Perplexity key yet" is the likeliest partial setup. Reading only the
   * CONFIGURED provider would leave such a deployment unable to search at all.
   */
  test("uses whichever provider is keyed when the preferred one is not", async () => {
    await withEnv(
      { PARALLEL_API_KEY: "par-test", AI_WEB_SEARCH_PROVIDER: "perplexity" },
      async () => {
        const result = await searchWithFallback(
          request,
          fakeAdapters("ok", "ok"),
        );
        expect(result.provider).toBe("parallel");
        expect(calls).toEqual(["parallel"]);
      },
    );
  });

  test("an operator can disable the fallback hop", async () => {
    await withEnv(
      { ...BOTH_KEYS, AI_WEB_SEARCH_FALLBACK: "false" },
      async () => {
        const message = await rejectionOf(() =>
          searchWithFallback(request, fakeAdapters("throw", "ok")),
        );
        expect(message).toBe("perplexity is down");
        expect(calls).toEqual(["perplexity"]);
      },
    );
  });

  test("reports no results rather than throwing when the only provider is empty", async () => {
    await withEnv({ PERPLEXITY_API_KEY: "pplx-test" }, async () => {
      const result = await searchWithFallback(
        request,
        fakeAdapters("empty", "ok"),
      );
      expect(result.results).toEqual([]);
      expect(result.cost.costUsd).toBe(0);
    });
  });

  test("refuses the call when no provider is configured at all", async () => {
    await withEnv({}, async () => {
      const message = await rejectionOf(() =>
        searchWithFallback(request, fakeAdapters("ok", "ok")),
      );
      expect(message).toContain("PERPLEXITY_API_KEY or PARALLEL_API_KEY");
    });
  });
});

/**
 * Images at search time, harvested from the pages the search returned.
 *
 * The affordance Tavily had — ask for images, get images, without first
 * choosing a page to open — restored over a stack whose search providers
 * return text only. What has to hold is that it is OPT-IN, that it reads a
 * bounded number of sources, and above all that it can never sink the search
 * it garnishes.
 */
describe("imagesForSearch", () => {
  const hits = [
    { url: "https://a.test/1" },
    { url: "https://a.test/2" },
    { url: "https://a.test/3" },
    { url: "https://a.test/4" },
  ];

  test("reads a bounded number of sources", async () => {
    const read: string[][] = [];
    const images = await harvestImages(
      hits,
      async (urls: string[]) => {
        read.push(urls);
        return {
          results: urls.map((url) => ({
            images: [{ url: `${url}/photo.jpg` }],
          })),
        };
      },
      3,
    );

    expect(read[0]).toHaveLength(3);
    expect(images).toHaveLength(3);
  });

  test("is empty when the search returned nothing to read", async () => {
    let called = false;
    const images = await harvestImages([], async () => {
      called = true;
      return { results: [] };
    });
    expect(images).toEqual([]);
    expect(called).toBe(false);
  });

  /**
   * A garnish must never cost the answer: an unconfigured fetch backend or a
   * provider having a bad minute loses the strip, not the search.
   */
  test("swallows a failing harvest rather than failing the search", async () => {
    const images = await harvestImages(hits, () => {
      throw new Error("extract is down");
    });
    expect(images).toEqual([]);
  });
});

describe("filterHits", () => {
  const outcome: WebSearchOutcome = {
    results: [hit("keep"), hit("drop")],
    images: [],
  };

  /**
   * Perplexity takes ONE domain list and refuses an allowlist and a denylist in
   * the same request. When the model passes both, the exclusions would be
   * silently dropped on the wire — a filter asked for and not applied is worse
   * than one refused.
   */
  test("applies exclusions the provider could not take alongside an allowlist", () => {
    const result = filterHits(
      outcome,
      ["drop.test"],
      ["keep.test", "drop.test"],
    );
    expect(result.results.map((r) => r.url)).toEqual(["https://keep.test/a"]);
  });

  test("leaves results alone when only one list was given", () => {
    expect(filterHits(outcome, ["drop.test"], undefined).results).toHaveLength(
      2,
    );
    expect(filterHits(outcome, undefined, ["keep.test"]).results).toHaveLength(
      2,
    );
  });

  test("matches subdomains of an excluded domain", () => {
    const nested: WebSearchOutcome = {
      results: [{ ...hit("x"), url: "https://news.drop.test/a" }],
      images: [],
    };
    expect(
      filterHits(nested, ["drop.test"], ["drop.test"]).results,
    ).toHaveLength(0);
  });
});

describe("webCacheKey", () => {
  /**
   * Redis keys surface in logs, `SCAN` output and metrics. A user's question
   * does not belong in any of them.
   */
  test("does not carry the query text", () => {
    const key = webCacheKey("search", "perplexity", {
      queries: ["confidential merger target"],
    });
    expect(key).not.toContain("confidential");
    expect(key).toStartWith("web:v1:search:perplexity:");
  });

  test("separates different arguments and different providers", () => {
    const a = webCacheKey("search", "perplexity", { queries: ["a"] });
    const b = webCacheKey("search", "perplexity", { queries: ["b"] });
    const c = webCacheKey("search", "parallel", { queries: ["a"] });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("withWebCache", () => {
  const worthCaching = (value: string[]): boolean => value.length > 0;

  test("a repeat call is served from the store and labelled", async () => {
    let computed = 0;
    const compute = async () => {
      computed += 1;
      return ["hit"];
    };

    const first = await withWebCache("k1", 60, worthCaching, compute);
    const second = await withWebCache("k1", 60, worthCaching, compute);

    expect(first).toEqual({ value: ["hit"], cached: false });
    expect(second).toEqual({ value: ["hit"], cached: true });
    expect(computed).toBe(1);
  });

  /**
   * Zero hits is usually a transient provider state. Pinning it would turn one
   * bad moment into an agent that can find nothing on a subject for a quarter
   * of an hour — which is why this cache is stricter than `selectOrCache`,
   * whose rule is "anything non-nullish".
   */
  test("never stores a result the caller called worthless", async () => {
    let computed = 0;
    const compute = async () => {
      computed += 1;
      return computed === 1 ? [] : ["hit"];
    };

    await withWebCache("k2", 60, worthCaching, compute);
    const second = await withWebCache("k2", 60, worthCaching, compute);

    expect(second).toEqual({ value: ["hit"], cached: false });
    expect(computed).toBe(2);
  });

  test("a zero TTL disables it", async () => {
    let computed = 0;
    const compute = async () => {
      computed += 1;
      return ["hit"];
    };

    await withWebCache("k3", 0, worthCaching, compute);
    await withWebCache("k3", 0, worthCaching, compute);

    expect(computed).toBe(2);
  });

  /**
   * A cache is an optimisation. An unreachable one must degrade to "call the
   * provider", never to a failed tool call.
   */
  test("still answers when the store throws", async () => {
    const { redisDouble } = await import("../../lib/redis-double");
    const realGet = redisDouble.get;
    redisDouble.get = () => {
      throw new Error("redis down");
    };
    try {
      const result = await withWebCache("k4", 60, worthCaching, async () => [
        "hit",
      ]);
      expect(result).toEqual({ value: ["hit"], cached: false });
    } finally {
      redisDouble.get = realGet;
    }
  });
});
