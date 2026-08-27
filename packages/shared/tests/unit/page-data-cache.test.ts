import { describe, expect, test } from "bun:test";
import type { PageDataResponse } from "../../src/schemas/pages";
import { mockModule } from "./mock-module";

/**
 * An in-memory stand-in for Redis.
 *
 * Only the client is replaced — see `mockModule` for why the rest of the
 * module keeps its real exports.
 *
 * TTL is not simulated: expiry is Redis' own behaviour, not this module's, and
 * a test that slept for it would only be testing `EX`.
 */
const store = new Map<string, string>();

await mockModule("../../src/lib/redis", {
  redis: {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve("OK");
    },
    del: (...keys: string[]) => {
      for (const key of keys) store.delete(key);
      return Promise.resolve(keys.length);
    },
  },
  selectOrCache: <T>(fn: () => Promise<T>) => fn(),
  deleteKeysByPrefix: () => Promise.resolve(),
});

const { cachedPageData, pageDataCacheKey } =
  await import("../../src/services/pages/data-cache");

/**
 * The authenticated response cache.
 *
 * What it must never do is more interesting than what it does: serve one team
 * the rows of another, serve an edited page its predecessor's answer, or let a
 * failed run poison an entry. And the stampede guard is the reason it exists at
 * all — a cache that lets every concurrent reader miss at once has not removed
 * the load, only delayed it.
 */

let counter = 0;
/** A key nobody else in this file reuses. */
const freshKey = (): string => `page:data:test:${(counter++).toString()}`;

const response = (marker: string): PageDataResponse => ({
  datasets: { d: { status: "ok", rows: [{ marker }], truncated: false } },
});

const markerOf = (result: PageDataResponse): unknown => {
  const dataset = result.datasets["d"];
  return dataset?.status === "ok"
    ? Reflect.get(Object(dataset.rows[0]), "marker")
    : undefined;
};

describe("cachedPageData", () => {
  test("the second call does not execute", async () => {
    const key = freshKey();
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(response(`run-${runs.toString()}`));
    };
    expect(markerOf(await cachedPageData({ key, run }))).toBe("run-1");
    expect(markerOf(await cachedPageData({ key, run }))).toBe("run-1");
    expect(runs).toBe(1);
  });

  test("concurrent misses collapse into ONE execution", async () => {
    // The stampede: without singleflight, an entry expiring under load costs a
    // full set of aggregate queries per concurrent reader.
    const key = freshKey();
    let runs = 0;
    const run = async () => {
      runs += 1;
      await Bun.sleep(30);
      return response(`run-${runs.toString()}`);
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => cachedPageData({ key, run })),
    );
    expect(runs).toBe(1);
    expect(results.map(markerOf)).toEqual(
      Array.from({ length: 8 }, () => "run-1"),
    );
  });

  test("`fresh` bypasses the read and repopulates the same entry", async () => {
    const key = freshKey();
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(response(`run-${runs.toString()}`));
    };
    await cachedPageData({ key, run });
    expect(markerOf(await cachedPageData({ key, fresh: true, run }))).toBe(
      "run-2",
    );
    // Repopulated, not invalidated: the next ordinary reader gets the new value
    // rather than paying for another execution.
    expect(markerOf(await cachedPageData({ key, run }))).toBe("run-2");
    expect(runs).toBe(2);
  });

  test("a failed run is not cached, and leaves nothing in flight", async () => {
    const key = freshKey();
    let runs = 0;
    const failing = () => {
      runs += 1;
      return Promise.reject(new Error("query exploded"));
    };
    const failure = await cachedPageData({ key, run: failing }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    // The next call must actually retry rather than await a settled rejection.
    expect(
      markerOf(
        await cachedPageData({
          key,
          run: () => Promise.resolve(response("ok")),
        }),
      ),
    ).toBe("ok");
    expect(runs).toBe(1);
  });
});

describe("pageDataCacheKey — what must never share an entry", () => {
  const base = {
    pageId: "page-1",
    teamId: "team-1",
    userId: null,
    definitionFingerprint: "2026-08-11T00:00:00.000Z",
    connectionsEpoch: "0.0",
    request: { variables: { month: "2026-08" } },
  };

  test("two teams reading the same shared page never collide", () => {
    // Each team sees its OWN records through the same definition — a key
    // without the team would hand one team the other's rows.
    expect(pageDataCacheKey(base)).not.toBe(
      pageDataCacheKey({ ...base, teamId: "team-2" }),
    );
  });

  test("two viewers never collide — a personal connection makes answers viewer-specific", () => {
    const mine = pageDataCacheKey({ ...base, userId: "user-1" });
    const theirs = pageDataCacheKey({ ...base, userId: "user-2" });
    const anonymous = pageDataCacheKey(base);
    expect(new Set([mine, theirs, anonymous]).size).toBe(3);
    // The anonymous sentinel is explicit, not an empty segment a viewer id
    // could ever equal.
    expect(anonymous).toContain(":u:public:");
  });

  test("editing the page retires its entries", () => {
    expect(pageDataCacheKey(base)).not.toBe(
      pageDataCacheKey({
        ...base,
        definitionFingerprint: "2026-08-11T00:00:01.000Z",
      }),
    );
  });

  test("connecting an app retires them too — the wall a TTL cannot be allowed to hold", () => {
    // A stale figure is a figure. A stale `needs_connection` tells the viewer
    // that connecting the app did not work, which is what a user got stuck on.
    expect(pageDataCacheKey(base)).not.toBe(
      pageDataCacheKey({ ...base, connectionsEpoch: "0.1" }),
    );
  });

  test("the window and the variables both move the key", () => {
    const keys = new Set([
      pageDataCacheKey(base),
      pageDataCacheKey({
        ...base,
        request: { variables: { month: "2026-07" } },
      }),
      pageDataCacheKey({
        ...base,
        request: { ...base.request, queries: { deals: { page: 2 } } },
      }),
      pageDataCacheKey({
        ...base,
        request: { ...base.request, datasetIds: ["deals"] },
      }),
    ]);
    expect(keys.size).toBe(4);
  });
});
