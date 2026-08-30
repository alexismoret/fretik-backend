import { afterEach, describe, expect, test } from "bun:test";
import type { AaMetrics } from "../../src/model-registry/types";
import {
  fetchArtificialAnalysis,
  matchAaRecord,
  normalizeAaKey,
} from "../../src/services/model-registry/sync/sources/artificial-analysis";

/**
 * The Artificial Analysis source, after the 2026-08-29 migration off
 * `/api/v2/data/llms/models` (410 Gone from 2026-11-04) onto the free-tier
 * `/api/v2/language/models/free`.
 *
 * Every payload below is shaped from a live response on 2026-08-29. Three
 * things changed between the routes and each one silently corrupts a figure if
 * it is carried over unexamined:
 *
 *  - timings moved UNDER `performance`. Reading them at the top level yields
 *    `undefined` for all 624 models — a fleet-wide blanking that looks exactly
 *    like "AA has not measured these yet";
 *  - the absence sentinel INVERTED. Legacy never used null and wrote `0`
 *    (throughput 0 on 442 of 624); this route writes `null` and keeps `0` for
 *    real values;
 *  - the response is PAGINATED, 200 per page. Reading page one only would grade
 *    the first 200 models and silently drop the rest.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = "test-aa-key";
});
process.env.ARTIFICIAL_ANALYSIS_API_KEY = "test-aa-key";

interface RawModel {
  name?: string;
  slug?: string;
  evaluations?: {
    artificial_analysis_intelligence_index?: number | null;
    artificial_analysis_coding_index?: number | null;
    artificial_analysis_agentic_index?: number | null;
  };
  performance?: {
    median_time_to_first_answer_token_seconds?: number | null;
  };
  /** Present on the wire; the source must not surface it. See the last suite. */
  pricing?: Record<string, number | null>;
}

const page = (
  models: RawModel[],
  over: { hasMore?: boolean; totalPages?: number; version?: number } = {},
): unknown => ({
  data: models,
  intelligence_index_version: over.version ?? 4.1,
  tier: "free",
  pagination: {
    page: 1,
    page_size: 200,
    total_pages: over.totalPages ?? 1,
    has_more: over.hasMore ?? false,
  },
});

/**
 * Install a fetch stub. Built by composition rather than a cast: `fetch` also
 * carries `preconnect`, so a bare function is not one.
 */
const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const stubFetch = (handler: (page: number) => Response): void => {
  const stub = (input: string | URL | Request): Promise<Response> =>
    Promise.resolve(
      handler(Number(new URL(urlOf(input)).searchParams.get("page") ?? "1")),
    );
  globalThis.fetch = Object.assign(stub, {
    preconnect: realFetch.preconnect.bind(realFetch),
  });
};

/** Serve one body per page number; `"fail"` and anything beyond it is a 503. */
const serve = (bodies: unknown[]): void => {
  stubFetch((requested) => {
    const body = bodies[requested - 1];
    return body === undefined || body === "fail"
      ? new Response("upstream down", { status: 503 })
      : Response.json(body);
  });
};

describe("pagination", () => {
  test("assembles every page, then stops when has_more turns false", async () => {
    serve([
      page([{ slug: "model-a" }], { hasMore: true, totalPages: 3 }),
      page([{ slug: "model-b" }], { hasMore: true, totalPages: 3 }),
      page([{ slug: "model-c" }], { hasMore: false, totalPages: 3 }),
    ]);
    const lookup = await fetchArtificialAnalysis();
    expect([...lookup.keys()].sort()).toEqual(["modela", "modelb", "modelc"]);
  });

  test("a FIRST-page failure yields an empty map, not a partial fleet", async () => {
    serve(["fail"]);
    expect((await fetchArtificialAnalysis()).size).toBe(0);
  });

  test("a LATER-page failure keeps what was read", async () => {
    // Safe because the sync writes `aaMetrics` only where the lookup HITS, so
    // a model on the missing page keeps the grades it already had. Returning
    // nothing would instead discard the three quarters that did arrive.
    serve([
      page([{ slug: "model-a" }], { hasMore: true, totalPages: 4 }),
      "fail",
    ]);
    const lookup = await fetchArtificialAnalysis();
    expect([...lookup.keys()]).toEqual(["modela"]);
  });

  test("stops at the page cap when has_more never turns false", async () => {
    // A runaway loop would burn the 100 requests/day budget and leave every
    // later run of the day ungraded, so the cap is a safety stop, not a budget.
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return Response.json(
        page([{ slug: `m${calls.toString()}` }], { hasMore: true }),
      );
    });
    await fetchArtificialAnalysis();
    expect(calls).toBe(10);
  });

  test("no API key means no call at all", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return Response.json(page([]));
    });
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    const lookup = await fetchArtificialAnalysis();
    expect(called).toBe(false);
    expect(lookup.size).toBe(0);
  });
});

describe("field extraction", () => {
  const one = async (raw: RawModel): Promise<AaMetrics> => {
    serve([page([raw])]);
    const hit = (await fetchArtificialAnalysis()).get(
      normalizeAaKey(raw.slug ?? raw.name ?? ""),
    );
    if (hit === undefined) throw new Error("model not in the lookup");
    return hit;
  };

  test("reads the three indices, agentic included", async () => {
    // Agentic is NEW: the legacy route declared the field and populated it for
    // none of our models, so a suite that never asserts it would not notice the
    // day it silently stopped arriving again.
    const metrics = await one({
      slug: "gpt-5-6-luna-low",
      evaluations: {
        artificial_analysis_intelligence_index: 33.9,
        artificial_analysis_coding_index: 44.2,
        artificial_analysis_agentic_index: 25.7,
      },
    });
    expect(metrics.intelligenceIndex).toBe(33.9);
    expect(metrics.codingIndex).toBe(44.2);
    expect(metrics.agenticIndex).toBe(25.7);
  });

  test("reads the first-answer timing from UNDER `performance`", async () => {
    // Top-level on the legacy route, nested here. Reading the old path returns
    // undefined for every model and reads as "not measured yet".
    const metrics = await one({
      slug: "glm-5-3-flash",
      performance: { median_time_to_first_answer_token_seconds: 41.97 },
    });
    expect(metrics.timeToFirstAnswerTokenSeconds).toBe(41.97);
  });

  test("a null index is absence; a ZERO index is a score and is kept", async () => {
    const nulled = await one({
      slug: "ungraded",
      evaluations: { artificial_analysis_coding_index: null },
    });
    expect(nulled.codingIndex).toBeUndefined();

    const zero = await one({
      slug: "scored-zero",
      evaluations: { artificial_analysis_coding_index: 0 },
    });
    expect(zero.codingIndex).toBe(0);
  });

  test("a ZERO timing is dropped, because it would render as instant", async () => {
    // One-sided guard: this route reports null and never zero on timings, so
    // dropping a zero costs nothing, while publishing one would put "answers
    // in 0.00 s" on a latency gauge.
    const metrics = await one({
      slug: "zero-timed",
      performance: { median_time_to_first_answer_token_seconds: 0 },
    });
    expect(metrics.timeToFirstAnswerTokenSeconds).toBeUndefined();
  });

  test("stamps the index version every grade was measured on", async () => {
    // A floor like `intelligence >= 45` only means something within one
    // version; AA renumbers the fleet on a major bump.
    const metrics = await one({ slug: "versioned" });
    expect(metrics.indexVersion).toBe("4.1");
  });

  test("carries the version from page one onto later pages", async () => {
    serve([
      page([{ slug: "first" }], { hasMore: true, totalPages: 2, version: 4.1 }),
      page([{ slug: "second" }], { hasMore: false, totalPages: 2 }),
    ]);
    const lookup = await fetchArtificialAnalysis();
    expect(lookup.get("second")?.indexVersion).toBe("4.1");
  });
});

describe("this source carries GRADES ONLY", () => {
  test("prices and throughput on the wire never reach the metrics", async () => {
    // Not an oversight — the pin for a deliberate decision (2026-08-29). AA
    // aggregates over hosts our pool never routes to (24 of 624 quote a price
    // of 0 while our pool prices the same model at $0.800 blended) AND
    // publishes one record per effort level, so both figures would describe a
    // model we do not run. Prices come from the pool median, speeds from the
    // endpoint stats — both measured on the routes we actually reach.
    serve([
      page([
        {
          slug: "well-stocked",
          evaluations: {
            artificial_analysis_intelligence_index: 52.3,
            artificial_analysis_coding_index: 71.4,
            artificial_analysis_agentic_index: 46.9,
          },
          pricing: {
            price_1m_input_tokens: 0.2,
            price_1m_output_tokens: 1.2,
            price_1m_cache_hit_tokens: 0.02,
          },
          performance: {
            median_time_to_first_answer_token_seconds: 1.83,
          },
        },
      ]),
    ]);
    const metrics = (await fetchArtificialAnalysis()).get("wellstocked");
    expect(metrics).toBeDefined();
    // Asserted on the SERIALIZED shape, which is what reaches the jsonb column:
    // absent fields are `undefined`, and `Object.keys` would still list those.
    // An exact list rather than a search for price-shaped names, so it fails the
    // day a field is ADDED — which is when someone is putting one of these back
    // without having read why it went.
    const stored: unknown = JSON.parse(JSON.stringify(metrics));
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      "agenticIndex",
      "codingIndex",
      "fetchedAt",
      "indexVersion",
      "intelligenceIndex",
      "slug",
      "timeToFirstAnswerTokenSeconds",
    ]);
  });
});

describe("keying", () => {
  test("indexes by slug AND by name, with the slug winning a collision", async () => {
    serve([
      page([
        { slug: "real-slug", name: "Shared Label" },
        { slug: "shared-label", name: "Another" },
      ]),
    ]);
    const lookup = await fetchArtificialAnalysis();
    // "Shared Label" folds to the same key as the second model's slug. The slug
    // holder must keep it — a display name is the weaker claim.
    expect(lookup.get("sharedlabel")?.slug).toBe("shared-label");
    expect(lookup.get("realslug")?.slug).toBe("real-slug");
  });
});

describe("matchAaRecord — the effort-level trap", () => {
  const record = (slug: string, intelligence: number): AaMetrics => ({
    slug,
    intelligenceIndex: intelligence,
  });
  // The real ladder, measured: one model, six records, 33.9 to 51.2.
  const lookup = new Map<string, AaMetrics>([
    ["gpt56luna", record("gpt-5-6-luna", 43.2)],
    ["gpt56lunaxhigh", record("gpt-5-6-luna-xhigh", 51.2)],
    ["gpt56lunalow", record("gpt-5-6-luna-low", 33.9)],
  ]);

  test("the curated slug wins over every fallback", () => {
    // Without this ordering the profile key matches the family's BASE record
    // and grades a rung we do not run — 43.2 where the truth is 51.2. A wrong
    // rung is worse than no match: it is plausible, and it feeds a tier floor.
    const hit = matchAaRecord(lookup, {
      aaSlug: "gpt-5-6-luna-xhigh",
      profileKey: "gpt-5.6-luna",
      modelIds: ["openai/gpt-5-6-luna"],
    });
    expect(hit?.intelligenceIndex).toBe(51.2);
  });

  test("falls back to the profile key when curation set no slug", () => {
    const hit = matchAaRecord(lookup, {
      profileKey: "gpt-5.6-luna",
      modelIds: [],
    });
    expect(hit?.slug).toBe("gpt-5-6-luna");
  });

  test("then to a model id, then to its tail", () => {
    const byTail = matchAaRecord(lookup, {
      profileKey: "no-such-profile",
      modelIds: ["openai/gpt-5-6-luna-low"],
    });
    expect(byTail?.slug).toBe("gpt-5-6-luna-low");
  });

  test("an unmatched curated slug does NOT block the fallbacks", () => {
    // A renamed slug upstream should degrade to the family record, not to null:
    // the sync warns elsewhere, and no grade at all is the worse outcome.
    const hit = matchAaRecord(lookup, {
      aaSlug: "gpt-5-6-luna-renamed-upstream",
      profileKey: "gpt-5-6-luna",
      modelIds: [],
    });
    expect(hit?.intelligenceIndex).toBe(43.2);
  });

  test("no match anywhere is null, never a neighbouring model", () => {
    expect(
      matchAaRecord(lookup, { profileKey: "claude-opus-5", modelIds: [] }),
    ).toBeNull();
  });
});
