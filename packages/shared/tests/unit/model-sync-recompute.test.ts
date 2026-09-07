import { describe, expect, test } from "bun:test";
import type { EndpointStat } from "../../src/model-registry/types";
import {
  type RecomputeRowState,
  recomputeRowPool,
} from "../../src/services/model-registry/sync/recompute";

/**
 * The one definition of what a model routes to.
 *
 * It was inline in `syncOneModel` while the nightly pass was the only thing
 * that could change a pool. An operator setting a price ceiling changes the
 * same five outputs, and a second copy of this arithmetic is how the pool
 * someone is shown stops matching the pool the next pass writes — so what these
 * tests pin is not the maths, which `model-sync-compute.test.ts` already
 * covers, but the SHAPE both callers depend on: the vetted-pool literal, the
 * anti-ratchet, and which policy grades which status.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"],
  hasZdr: true,
  ...over,
  wireNames: over.wireNames ?? { openrouter: over.provider },
});

const row = (over: Partial<RecomputeRowState> = {}): RecomputeRowState => ({
  profileKey: "acme-m1",
  status: "published",
  providerPool: {},
  poolWidened: false,
  maxInputPricePerMTok: null,
  maxOutputPricePerMTok: null,
  minMaxOutput: null,
  minContextLength: null,
  requireCache: null,
  boundRoles: [],
  ...over,
});

const three = [
  endpoint({ provider: "deepinfra" }),
  endpoint({
    provider: "dear",
    pricing: { inputPerMTok: 9, outputPerMTok: 40 },
  }),
  endpoint({ provider: "novita" }),
];

describe("recomputeRowPool", () => {
  test("the vetted pool carries `only` and `sort`, and never `order`", () => {
    const { vettedPool } = recomputeRowPool({
      row: row(),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(vettedPool).toEqual({
      only: ["deepinfra", "dear", "novita"],
      sort: "throughput",
    });
    // `order` would be silently fatal twice over: OpenRouter drops `sort` when
    // both are present, and an explicit order also disables the sticky routing
    // that keeps a multi-step turn on one warm cache.
    expect(vettedPool?.order).toBeUndefined();
  });

  test("`ignore` is carried across the recompute, `only` is not", () => {
    // The stored `only` names one host. Feeding it back would exclude the
    // other two as "not in the declared pool" and the list could only shrink —
    // the ratchet that made every seven-day quarantine permanent.
    const { vettedPool } = recomputeRowPool({
      row: row({
        providerPool: {
          openrouter: { only: ["deepinfra"], ignore: ["someoneelse"] },
        },
      }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(vettedPool?.only).toEqual(["deepinfra", "dear", "novita"]);
    expect(vettedPool?.ignore).toEqual(["someoneelse"]);
  });

  test("an empty pool yields no vetted pool at all, never an empty `only`", () => {
    // The caller relies on `undefined` to mean "do not overwrite what is
    // stored". An empty allow-list on the wire means "nothing may serve this".
    const { vettedPool, pool } = recomputeRowPool({
      row: row(),
      endpoints: [],
      transport: "openrouter",
      quarantined: [],
    });
    expect(pool.endpoints).toHaveLength(0);
    expect(vettedPool).toBeUndefined();
  });

  test("the quarantine list is the CALLER's, not the row's", () => {
    // The sync re-probes expired quarantines before recomputing, so it knows a
    // host is free before the row does. Recomputing off the stored array would
    // hold a released host out for one more day.
    const { pool } = recomputeRowPool({
      row: row(),
      endpoints: three,
      transport: "openrouter",
      quarantined: ["novita"],
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual([
      "deepinfra",
      "dear",
    ]);
  });

  test("status picks the policy, and the policy is returned for the caller to grade with", () => {
    const published = recomputeRowPool({
      row: row({ status: "published" }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    const candidate = recomputeRowPool({
      row: row({ status: "candidate" }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    // The two differ — that is the whole reason the policy travels back out
    // rather than being chosen again by the caller.
    expect(published.policy).not.toBe(candidate.policy);
  });

  test("operator limits reach the pool, the price and the context", () => {
    const capped = recomputeRowPool({
      row: row({ maxInputPricePerMTok: 2 }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(capped.pool.endpoints.map((e) => e.provider)).toEqual([
      "deepinfra",
      "novita",
    ]);
    expect(capped.vettedPool?.only).toEqual(["deepinfra", "novita"]);
    // The expensive host was dragging the median; removing it is the point.
    expect(capped.pricing.inputPerMTok).toBe(1);
  });
});
