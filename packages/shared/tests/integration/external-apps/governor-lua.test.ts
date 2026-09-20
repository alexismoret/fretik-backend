import { afterEach, describe, expect, test } from "bun:test";
import { redis } from "../../../src/lib/redis";
import {
  rateKey,
  semaphoreKey,
  statsDay,
  statsKey,
} from "../../../src/services/external-apps/exec/governor/keys";
import {
  govAcquire,
  govBlock,
  govRelease,
  readGovernorStats,
} from "../../../src/services/external-apps/exec/governor/lua";
import type { GovernorPolicy } from "../../../src/services/external-apps/exec/governor/policy";

/**
 * A rate limiter that has never met Redis is a rate limiter you are guessing
 * about.
 *
 * Everything the governor decides happens inside one Lua script — the block
 * check, the semaphore, two GCRA buckets, the commit — and every one of those
 * steps is a Redis primitive whose exact semantics the decision depends on:
 * `HGET` on a missing hash answers `false` and not `nil` inside Lua, `PTTL`
 * answers -2 for a key that does not exist, `ZREMRANGEBYSCORE` takes an
 * inclusive range. A double of Redis would let every one of those be wrong.
 *
 * So this suite runs the real script against the real server, and each case
 * names what to delete to see it go red.
 *
 * `now` is passed in rather than read from the clock: pacing is arithmetic on
 * timestamps, and a test that waited out real seconds would be slow AND flaky
 * — the two ways a timing test stops being run.
 */

const policy = (overrides: Partial<GovernorPolicy> = {}): GovernorPolicy => ({
  connectionId: `it-conn-${Math.random().toString(36).slice(2, 10)}`,
  providerKey: `it-prov-${Math.random().toString(36).slice(2, 10)}`,
  displayName: "Acme",
  perConnection: { requests: 3, perSeconds: 60, burst: 3 },
  perProvider: undefined,
  maxConcurrent: 2,
  retryAfterHeaders: [],
  maxWaitMs: 8_000,
  defaultRetryAfterMs: 30_000,
  maxBlockMs: 900_000,
  ...overrides,
});

const touched: string[] = [];
const track = (p: GovernorPolicy): GovernorPolicy => {
  touched.push(
    rateKey("conn", p.connectionId),
    rateKey("prov", p.providerKey),
    semaphoreKey(p.connectionId),
    statsKey("conn", p.connectionId, statsDay()),
    statsKey("prov", p.providerKey, statsDay()),
  );
  return p;
};

afterEach(async () => {
  if (touched.length > 0) await redis.del(...touched);
  touched.length = 0;
});

const NOW = Date.parse("2026-09-19T00:00:00.000Z");

describe("pacing — the budget is a budget across processes", () => {
  test("three per minute admits exactly three at once, and says when the fourth may go", async () => {
    // `burst: 3` on a 3/60s budget means "three back-to-back is within the
    // allowance". A fourth in the same millisecond is not, and the answer must
    // be the WAIT, not a poll: the caller has a deadline to compare it against.
    const p = track(policy({ maxConcurrent: 0 }));
    const token = "t";

    for (let i = 0; i < 3; i++) {
      const verdict = await govAcquire(
        p,
        `${token}${i.toString()}`,
        5_000,
        NOW,
      );
      expect(verdict.admitted).toBe(true);
    }

    const fourth = await govAcquire(p, "t3", 5_000, NOW);
    expect(fourth.admitted).toBe(false);
    expect(fourth.reason).toBe("conn_rate");
    // One emission interval: 60 s / 3.
    expect(fourth.waitMs).toBe(20_000);

    // Delete the `HSET tat` commit in `lua.ts` and this passes at four.
  });

  test("the allowance refills with time, not with a window rolling over", async () => {
    // A fixed window would admit three more at the stroke of the minute
    // whatever happened before it. GCRA refills one slot per interval, so 20 s
    // after the refusal exactly one more call goes.
    const p = track(policy({ maxConcurrent: 0 }));
    for (let i = 0; i < 3; i++) {
      await govAcquire(p, `a${i.toString()}`, 5_000, NOW);
    }
    expect((await govAcquire(p, "b0", 5_000, NOW + 19_999)).admitted).toBe(
      false,
    );
    expect((await govAcquire(p, "b1", 5_000, NOW + 20_000)).admitted).toBe(
      true,
    );
    expect((await govAcquire(p, "b2", 5_000, NOW + 20_000)).admitted).toBe(
      false,
    );
  });

  test("two connections of one provider share the provider bucket and nothing else", async () => {
    // The reason `perProvider` exists: an IP limit, and the Nango account limit
    // that applies to every proxied call whoever makes it. Per-connection state
    // cannot express it.
    const providerKey = `it-prov-${Math.random().toString(36).slice(2, 10)}`;
    const shared = { requests: 2, perSeconds: 60, burst: 2 };
    const first = track(
      policy({
        providerKey,
        perConnection: undefined,
        perProvider: shared,
        maxConcurrent: 0,
      }),
    );
    const second = track(
      policy({
        providerKey,
        perConnection: undefined,
        perProvider: shared,
        maxConcurrent: 0,
      }),
    );

    expect((await govAcquire(first, "x", 5_000, NOW)).admitted).toBe(true);
    expect((await govAcquire(second, "y", 5_000, NOW)).admitted).toBe(true);
    // The third call is on a THIRD connection's behalf and still refused.
    const third = await govAcquire(second, "z", 5_000, NOW);
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe("prov_rate");
  });

  test("a refusal by the shared bucket does not spend the connection's allowance", async () => {
    // The ordering the script is written for. If the connection bucket were
    // committed before the provider bucket was checked, a retried call would
    // pay twice and a 3/min budget would deliver 1.5.
    const p = track(
      policy({
        perConnection: { requests: 3, perSeconds: 60, burst: 3 },
        perProvider: { requests: 1, perSeconds: 60, burst: 1 },
        maxConcurrent: 0,
      }),
    );
    expect((await govAcquire(p, "one", 5_000, NOW)).admitted).toBe(true);
    for (let i = 0; i < 5; i++) {
      const refused = await govAcquire(p, `n${i.toString()}`, 5_000, NOW);
      expect(refused.reason).toBe("prov_rate");
    }

    // Same buckets, provider ceiling lifted — what the sixth retry meets. The
    // connection has spent exactly ONE of its three, so exactly two more go
    // through at the same instant and the third is paced.
    const lifted = { ...p, perProvider: undefined };
    expect((await govAcquire(lifted, "two", 5_000, NOW)).admitted).toBe(true);
    expect((await govAcquire(lifted, "three", 5_000, NOW)).admitted).toBe(true);
    const fourth = await govAcquire(lifted, "four", 5_000, NOW);
    expect(fourth.admitted).toBe(false);
    expect(fourth.reason).toBe("conn_rate");

    // Move the `HSET tat` for the connection bucket above the provider check
    // and the five refusals eat the whole allowance: "two" is refused instead.
  });
});

describe("concurrency — seats, not calls per second", () => {
  test("two held seats refuse the third, and releasing one lets it in", async () => {
    const p = track(policy({ perConnection: undefined, maxConcurrent: 2 }));
    expect((await govAcquire(p, "s1", 60_000, NOW)).admitted).toBe(true);
    expect((await govAcquire(p, "s2", 60_000, NOW)).admitted).toBe(true);

    const third = await govAcquire(p, "s3", 60_000, NOW);
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe("concurrency");

    await govRelease(p, "s1");
    expect((await govAcquire(p, "s3", 60_000, NOW)).admitted).toBe(true);

    // Delete the `ZADD` and the third is admitted with two live holders.
  });

  test("a seat whose holder died is reclaimed, never leaked", async () => {
    // A replica that crashes mid-call must not cost this connection a seat
    // forever — which is the failure a plain INCR counter has and a scored set
    // does not.
    const p = track(policy({ perConnection: undefined, maxConcurrent: 1 }));
    expect((await govAcquire(p, "ghost", 10_000, NOW)).admitted).toBe(true);
    expect((await govAcquire(p, "live", 10_000, NOW + 9_999)).admitted).toBe(
      false,
    );
    expect((await govAcquire(p, "live", 10_000, NOW + 10_001)).admitted).toBe(
      true,
    );
  });

  test("a connection with no seat limit takes as many as it likes", async () => {
    const p = track(policy({ perConnection: undefined, maxConcurrent: 0 }));
    for (let i = 0; i < 12; i++) {
      expect(
        (await govAcquire(p, `u${i.toString()}`, 5_000, NOW)).admitted,
      ).toBe(true);
    }
    expect(await redis.exists(semaphoreKey(p.connectionId))).toBe(0);
  });
});

describe("a 429 is shared, not survived", () => {
  test("one caller's refusal stops every other caller until it lifts", async () => {
    const p = track(policy({ perConnection: undefined, maxConcurrent: 0 }));
    await govBlock(p, "conn", 30_000, NOW);

    const during = await govAcquire(p, "after", 5_000, NOW + 1_000);
    expect(during.admitted).toBe(false);
    expect(during.reason).toBe("blocked");
    expect(during.waitMs).toBe(29_000);

    expect((await govAcquire(p, "later", 5_000, NOW + 30_001)).admitted).toBe(
      true,
    );
  });

  test("a longer block wins over a shorter one, in either order", async () => {
    // Two replicas race on the same refusal, reading different headers. The one
    // that read 10 s must not shorten the one that read 5 min.
    const p = track(policy({ perConnection: undefined, maxConcurrent: 0 }));
    await govBlock(p, "conn", 300_000, NOW);
    await govBlock(p, "conn", 10_000, NOW);
    const verdict = await govAcquire(p, "x", 5_000, NOW + 11_000);
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toBe("blocked");
  });

  test("a block on the provider stops every connection of that provider", async () => {
    const providerKey = `it-prov-${Math.random().toString(36).slice(2, 10)}`;
    const blocked = track(
      policy({ providerKey, perConnection: undefined, maxConcurrent: 0 }),
    );
    const sibling = track(
      policy({ providerKey, perConnection: undefined, maxConcurrent: 0 }),
    );
    await govBlock(blocked, "prov", 60_000, NOW);
    expect((await govAcquire(sibling, "s", 5_000, NOW)).reason).toBe("blocked");
  });

  test("a block is clamped to the policy's ceiling, however long the app asks", async () => {
    // An app that answers `Retry-After: 86400` would otherwise take a
    // connection out for a day on one bad minute.
    const p = track(
      policy({
        perConnection: undefined,
        maxConcurrent: 0,
        maxBlockMs: 60_000,
      }),
    );
    await govBlock(p, "conn", 86_400_000, NOW);
    expect((await govAcquire(p, "x", 5_000, NOW + 60_001)).admitted).toBe(true);
  });
});

describe("what it counts", () => {
  test("admitted calls and refusals are counted on both scopes", async () => {
    const p = track(policy({ maxConcurrent: 0 }));
    for (let i = 0; i < 3; i++) {
      await govAcquire(p, `c${i.toString()}`, 5_000, NOW);
    }
    await govAcquire(p, "refused", 5_000, NOW);
    await govBlock(p, "conn", 5_000, NOW);

    // Read the day the WRITES belong to. `readGovernorStats` defaults to
    // today, and every call above was stamped `NOW` — so the default read the
    // right bucket on the day this was written and an empty one every day
    // after. A test that passes on one date is not a test.
    const day = statsDay(new Date(NOW));
    const own = await readGovernorStats("conn", p.connectionId, day);
    const shared = await readGovernorStats("prov", p.providerKey, day);
    // Three admitted; the refusal is not a call, because nothing left.
    expect(own.calls).toBe(3);
    expect(shared.calls).toBe(3);
    expect(own.rateLimited).toBe(1);
  });

  test("a bucket nobody has touched reads as zero, not as an error", async () => {
    const stats = await readGovernorStats("conn", "never-seen");
    expect(stats).toEqual({ calls: 0, rateLimited: 0 });
  });
});
