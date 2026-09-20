import { describe, expect, test } from "bun:test";
import { SYNC_LIMITS, syncRunCeiling } from "../../src/schemas/collection-sync";
import { estimateSyncCost } from "../../src/services/collection-sync/estimate-cost";

/**
 * What one run costs upstream — the number a person reads before choosing a
 * cadence, and the number that was wrong.
 *
 * `estimateSyncCost` priced every run by the action's declared page size: no
 * page size, one call. That is right for a `table` whose answer arrives whole,
 * and wrong for EVERY `lookup`, because a lookup's cost has nothing to do with
 * pagination — it calls the app once per record. A lookup on an un-batched
 * action was therefore quoted at 1 call per run against a true 200, and the one
 * surface that exists to catch a cadence that cannot fit was understating it
 * two hundred fold, in the direction that spends somebody else's quota.
 *
 * Unit because it is arithmetic over four declared numbers. The assertions that
 * matter are the ones that would have been GREEN under the old code — every
 * table case — set beside the lookup cases that would have been red.
 */

const table = SYNC_LIMITS.defaultRowCap;

describe("a table source pays per page", () => {
  test("a declared page size divides the row cap", () => {
    expect(
      syncRunCeiling({ kind: "table", rowCap: 20_000, pageSize: 1_000 }),
    ).toEqual({ records: 20_000, calls: 20 });
  });

  test("a partial last page still costs a call", () => {
    expect(
      syncRunCeiling({ kind: "table", rowCap: 20_001, pageSize: 1_000 }),
    ).toEqual({ records: 20_001, calls: 21 });
  });

  test("no declared page size means the answer arrives whole: one call", () => {
    expect(syncRunCeiling({ kind: "table", rowCap: 50_000 })).toEqual({
      records: 50_000,
      calls: 1,
    });
  });

  test("an absent row cap falls back to the default rather than to zero", () => {
    expect(syncRunCeiling({ kind: "table", pageSize: 100 })).toEqual({
      records: table,
      calls: table / 100,
    });
  });
});

describe("a lookup source pays per record", () => {
  /**
   * THE REGRESSION. Under the old arithmetic this was `calls: 1`, because an
   * action that answers about one record declares no pagination.
   */
  test("an un-batched action costs one call per record, not one per run", () => {
    expect(syncRunCeiling({ kind: "lookup" })).toEqual({
      records: SYNC_LIMITS.lookupBatchSize,
      calls: SYNC_LIMITS.lookupBatchSize,
    });
    expect(syncRunCeiling({ kind: "lookup" }).calls).toBeGreaterThan(
      syncRunCeiling({ kind: "table", rowCap: 20_000, pageSize: 1_000 }).calls,
    );
  });

  test("a page size does not make a lookup cheaper — it is not walking", () => {
    expect(syncRunCeiling({ kind: "lookup", pageSize: 1_000 })).toEqual(
      syncRunCeiling({ kind: "lookup" }),
    );
  });

  test("batching is the only thing that divides the cost", () => {
    // 400 calls × 50 ids is 20 000, which is exactly the per-run record cap.
    expect(syncRunCeiling({ kind: "lookup", batchMaxItems: 50 })).toEqual({
      records: SYNC_LIMITS.lookupMaxRecordsPerRun,
      calls: SYNC_LIMITS.maxUpstreamCallsPerRun,
    });
  });

  test("a large batch is bounded by the record cap, not the call budget", () => {
    // 400 × 500 = 200 000 ids the budget could carry; the run takes 20 000.
    expect(syncRunCeiling({ kind: "lookup", batchMaxItems: 500 })).toEqual({
      records: SYNC_LIMITS.lookupMaxRecordsPerRun,
      calls: SYNC_LIMITS.lookupMaxRecordsPerRun / 500,
    });
  });

  test("a batch of one is no batch — it must not divide by itself", () => {
    expect(syncRunCeiling({ kind: "lookup", batchMaxItems: 1 })).toEqual(
      syncRunCeiling({ kind: "lookup" }),
    );
  });
});

describe("the cadence is priced against what the app publishes", () => {
  /** 300 requests a minute is the default the governor gives a connection. */
  const budget = { requests: 300, perSeconds: 60 };

  test("a manual source spends nothing on a schedule", () => {
    const cost = estimateSyncCost({
      kind: "table",
      schedule: { mode: "manual" },
      rowCap: 20_000,
      pageSize: 1_000,
      budget,
    });
    expect(cost.runsPerDay).toBe(0);
    expect(cost.callsPerDay).toBe(0);
    expect(cost.warning).toBeUndefined();
  });

  /**
   * The case the whole estimate exists for. Quarter-hourly against an
   * un-batched lookup is 96 × 200 = 19 200 requests a day, well past the
   * 432 000 a minute-budget of 300 allows — so this one does NOT warn, and
   * saying so is the point: the warning is about the app's published budget,
   * while the number above is what a person weighs against their own patience.
   */
  test("an un-batched lookup is quoted per record, every run", () => {
    const cost = estimateSyncCost({
      kind: "lookup",
      schedule: { mode: "interval", everyMinutes: 15 },
      pageSize: undefined,
      budget,
    });
    expect(cost.runsPerDay).toBe(96);
    expect(cost.recordsPerRun).toBe(SYNC_LIMITS.lookupBatchSize);
    expect(cost.callsPerRun).toBe(SYNC_LIMITS.lookupBatchSize);
    expect(cost.callsPerDay).toBe(19_200);
  });

  test("a tight app budget warns, and the lookup warning names the reason", () => {
    const cost = estimateSyncCost({
      kind: "lookup",
      schedule: { mode: "interval", everyMinutes: 15 },
      pageSize: undefined,
      // 5 a minute — 7 200 a day against the 19 200 above.
      budget: { requests: 5, perSeconds: 60 },
    });
    expect(cost.appLimitPerDay).toBe(7_200);
    expect(cost.warning).toContain("one request per record");
  });

  test("the same cadence on a table source stays inside the same budget", () => {
    const cost = estimateSyncCost({
      kind: "table",
      schedule: { mode: "interval", everyMinutes: 15 },
      rowCap: 20_000,
      pageSize: 1_000,
      budget: { requests: 5, perSeconds: 60 },
    });
    // 96 × 20 = 1 920. The two kinds differ by an order of magnitude on one
    // screen, which is why the form has to show it.
    expect(cost.callsPerDay).toBe(1_920);
    expect(cost.warning).toBeUndefined();
  });

  test("an app that publishes no budget never warns", () => {
    const cost = estimateSyncCost({
      kind: "lookup",
      schedule: { mode: "interval", everyMinutes: 15 },
      pageSize: undefined,
      budget: undefined,
    });
    expect(cost.appLimitPerDay).toBeUndefined();
    expect(cost.warning).toBeUndefined();
  });
});
