import { describe, expect, it } from "bun:test";
import {
  SYNC_LIMITS,
  syncArgFieldKeys,
  type SyncArgs,
} from "../../src/schemas/collection-sync";
import { resolveSyncArgs } from "../../src/services/collection-sync/resolve-args";
import {
  computeNextRunAt,
  SYNC_FAILURE_DISABLE_THRESHOLD,
  syncBackoffMultiplier,
} from "../../src/services/collection-sync/sweep";

/**
 * The scheduling arithmetic, and the two argument bindings.
 *
 * The backoff is the part that is invisible until it is wrong in production:
 * its job is to make a source whose app has been refusing since yesterday stop
 * asking, WITHOUT pausing one that failed twice over lunch. The assertions
 * below pin both ends of that — the sequence is monotonic and capped, and the
 * threshold is far enough out that reaching it means a day of failures rather
 * than a bad afternoon.
 */

const at = (iso: string): Date => new Date(iso);

describe("syncBackoffMultiplier", () => {
  it("is 1 while nothing is failing", () => {
    expect(syncBackoffMultiplier(0)).toBe(1);
    expect(syncBackoffMultiplier(-1)).toBe(1);
  });

  it("doubles per consecutive failure", () => {
    expect([1, 2, 3, 4].map(syncBackoffMultiplier)).toEqual([1, 2, 4, 8]);
  });

  it("caps, so a long outage does not push the next try into next month", () => {
    expect(syncBackoffMultiplier(5)).toBe(16);
    expect(syncBackoffMultiplier(50)).toBe(16);
  });

  it("never goes backwards", () => {
    let previous = 0;
    for (let failures = 0; failures <= 20; failures += 1) {
      const multiplier = syncBackoffMultiplier(failures);
      expect(multiplier).toBeGreaterThanOrEqual(previous);
      previous = multiplier;
    }
  });
});

describe("computeNextRunAt", () => {
  const from = at("2026-03-04T10:00:00Z");

  it("adds the interval, plus jitter that is never negative", () => {
    const next = computeNextRunAt({
      schedule: { mode: "interval", everyMinutes: 60 },
      consecutiveFailures: 0,
      from,
      jitter: 0,
    });
    expect(next?.toISOString()).toBe("2026-03-04T11:00:00.000Z");
  });

  it("spreads teams by up to a tenth of the interval", () => {
    const next = computeNextRunAt({
      schedule: { mode: "interval", everyMinutes: 60 },
      consecutiveFailures: 0,
      from,
      jitter: 1,
    });
    // A jittered run is LATER than the cadence, never earlier: a team is never
    // asked sooner than it agreed to ask its app.
    expect(next?.getTime()).toBe(from.getTime() + 66 * 60_000);
  });

  it("backs a failing source off along the multiplier", () => {
    const minutes = (failures: number): number => {
      const next = computeNextRunAt({
        schedule: { mode: "interval", everyMinutes: 15 },
        consecutiveFailures: failures,
        from,
        jitter: 0,
      });
      return ((next?.getTime() ?? 0) - from.getTime()) / 60_000;
    };
    expect([1, 2, 3, 4, 5, 6].map(minutes)).toEqual([
      15, 30, 60, 120, 240, 240,
    ]);
  });

  it("gives a MANUAL source no slot at all, failing or not", () => {
    // Nothing scheduled it, so nothing retries it — a backoff here would put a
    // source the user only ever refreshes by hand into the sweep's index forever.
    expect(
      computeNextRunAt({
        schedule: { mode: "manual" },
        consecutiveFailures: 0,
      }),
    ).toBeNull();
    expect(
      computeNextRunAt({
        schedule: { mode: "manual" },
        consecutiveFailures: 7,
      }),
    ).toBeNull();
  });

  it("clamps an interval below the floor rather than honouring it", () => {
    const next = computeNextRunAt({
      // A row written around the wire schema — every run costs someone else's
      // rate limit, so the floor is enforced where the number is used too.
      schedule: { mode: "interval", everyMinutes: 1 },
      consecutiveFailures: 0,
      from,
      jitter: 0,
    });
    expect(((next?.getTime() ?? 0) - from.getTime()) / 60_000).toBe(
      SYNC_LIMITS.minIntervalMinutes,
    );
  });

  it("spans more than a day of retries before the auto-pause", () => {
    // The property the threshold exists for, asserted rather than described:
    // the full run of failures on a 15-minute source is over a DAY of trying,
    // not a bad afternoon. The first version of these constants spanned 11 h
    // while its comment claimed 32 — this is what caught it.
    let elapsedMinutes = 0;
    for (
      let failures = 1;
      failures <= SYNC_FAILURE_DISABLE_THRESHOLD;
      failures += 1
    ) {
      elapsedMinutes += 15 * syncBackoffMultiplier(failures);
    }
    expect(elapsedMinutes).toBeGreaterThan(24 * 60);
  });
});

describe("syncArgFieldKeys — what a diff is matched against", () => {
  it("finds a binding at the top level", () => {
    expect(syncArgFieldKeys({ siret: { $field: "siret" } })).toEqual(["siret"]);
  });

  it("finds one nested in an object or an array", () => {
    const args: SyncArgs = {
      filter: { company: { $field: "registration_no" } },
      ids: [{ $field: "external_ref" }, "literal"],
    };
    expect(syncArgFieldKeys(args).sort()).toEqual([
      "external_ref",
      "registration_no",
    ]);
  });

  it("deduplicates a key read twice", () => {
    expect(
      syncArgFieldKeys({ a: { $field: "k" }, b: { $field: "k" } }),
    ).toEqual(["k"]);
  });

  it("finds nothing in literals, and is not fooled by a lookalike", () => {
    expect(syncArgFieldKeys({ a: 1, b: "x", c: { $field: 3 } })).toEqual([]);
    expect(syncArgFieldKeys({ d: { $since: true } })).toEqual([]);
  });
});

describe("resolveSyncArgs — a binding resolves or its key disappears", () => {
  it("takes the value from the record", () => {
    const { args, missingFieldKeys } = resolveSyncArgs({
      args: { siret: { $field: "siret" }, page: 1 },
      fieldValues: { siret: "12345" },
    });
    expect(args).toEqual({ siret: "12345", page: 1 });
    expect(missingFieldKeys).toEqual([]);
  });

  it("DROPS the key and reports it when the record has no value", () => {
    const { args, missingFieldKeys } = resolveSyncArgs({
      args: { siret: { $field: "siret" } },
      fieldValues: { siret: "" },
    });
    // An absent argument means "no filter" and a null one means "filter on
    // null" — only the first is what a missing value intends, and the report is
    // what makes the record `missing` rather than the subject of a wasted call.
    expect(args).toEqual({});
    expect(missingFieldKeys).toEqual(["siret"]);
  });

  it("keeps an array's shape when one element cannot resolve", () => {
    const { args } = resolveSyncArgs({
      args: { ids: [{ $field: "a" }, { $field: "b" }] },
      fieldValues: { a: "1" },
    });
    // Dropping the element would shift every index after it, so only whole KEYS
    // are droppable.
    expect(args["ids"]).toEqual(["1", null]);
  });

  it("drops an empty nested object's key rather than sending {}", () => {
    const { args } = resolveSyncArgs({
      args: { filter: { company: { $field: "missing" } } },
      fieldValues: {},
    });
    expect(args).toEqual({ filter: {} });
  });

  it("resolves $since only when there is a last success", () => {
    const at2 = new Date("2026-03-04T05:06:07Z");
    expect(
      resolveSyncArgs({ args: { since: { $since: true } }, since: null }).args,
    ).toEqual({});
    expect(
      resolveSyncArgs({ args: { since: { $since: true } }, since: at2 }).args,
    ).toEqual({ since: "2026-03-04T05:06:07.000Z" });
  });
});
