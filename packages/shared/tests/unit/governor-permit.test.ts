import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * What the permit does AROUND the decision — the Lua script's own arithmetic is
 * proven against a real Redis in `tests/integration/external-apps/governor-lua`.
 *
 * Four properties, each of which fails silently and expensively:
 *
 *  - a connection nobody has declared anything about must pay NO round trip.
 *    This replaces `external-connection-slot.test.ts`'s first case, and for the
 *    same reason: if the quiet path ever started touching Redis, every read in
 *    the product would grow a hop to buy a guarantee one app needs.
 *  - the seat comes back when the call THROWS. A leaked seat makes a connection
 *    quieter every day until the hold expires, and nothing reports it.
 *  - a 429 is written cluster-wide BEFORE the error propagates, so the next
 *    replica waits instead of confirming it.
 *  - Redis being unreachable lets the call out rather than refusing it. A
 *    governor that fails closed turns a cache outage into an app outage.
 */

interface Recorded {
  acquires: number;
  releases: string[];
  blocks: { scope: string; forMs: number }[];
}

const recorded: Recorded = { acquires: 0, releases: [], blocks: [] };

/** What the next acquire answers. `"throw"` stands for Redis being down. */
let nextVerdict:
  { admitted: boolean; waitMs: number; reason: string } | "throw" = {
  admitted: true,
  waitMs: 0,
  reason: "ok",
};

await mockModule("../../src/services/external-apps/exec/governor/lua", {
  govAcquire: () => {
    recorded.acquires += 1;
    if (nextVerdict === "throw") {
      return Promise.reject(new Error("ECONNREFUSED"));
    }
    return Promise.resolve(nextVerdict);
  },
  govRelease: (_policy: unknown, token: string) => {
    recorded.releases.push(token);
    return Promise.resolve();
  },
  govBlock: (_policy: unknown, scope: string, forMs: number) => {
    recorded.blocks.push({ scope, forMs });
    return Promise.resolve();
  },
});

const providers: Record<string, unknown> = {};
await mockModule("../../src/external-apps/registry", {
  getProvider: (key: string) => providers[key],
});

const { withUpstreamPermit } =
  await import("../../src/services/external-apps/exec/governor/permit");
const { UpstreamHttpError, UpstreamRateLimitedError } =
  await import("../../src/services/external-apps/exec/governor/upstream-error");

const connection = (extra: {
  providerKey?: string;
  maxConcurrent?: number;
}) => ({
  id: "conn-1",
  providerKey: extra.providerKey ?? "quiet-app",
  displayName: "Acme",
  concurrencyMode: null,
  rateLimitRequests: null,
  rateLimitPerSeconds: null,
  maxConcurrent: extra.maxConcurrent ?? null,
});

beforeEach(() => {
  recorded.acquires = 0;
  recorded.releases.length = 0;
  recorded.blocks.length = 0;
  nextVerdict = { admitted: true, waitMs: 0, reason: "ok" };
  for (const key of Object.keys(providers)) delete providers[key];
  // Off, so "nothing declared" really means nothing.
  process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE = "0";
  delete process.env.EXTERNAL_APP_GOVERNOR_FAIL_OPEN;
});

describe("a connection nobody has measured pays nothing", () => {
  test("no budget, no seat limit, no round trip", async () => {
    const result = await withUpstreamPermit(
      connection({}),
      { kind: "interactive" },
      { holdMs: 1_000 },
      () => Promise.resolve("done"),
    );
    expect(result).toBe("done");
    expect(recorded.acquires).toBe(0);
  });

  test("one declared seat is enough to make it ask", async () => {
    // Only `maxConcurrent` differs from the case above.
    await withUpstreamPermit(
      connection({ maxConcurrent: 1 }),
      { kind: "interactive" },
      { holdMs: 1_000 },
      () => Promise.resolve(null),
    );
    expect(recorded.acquires).toBe(1);
  });

  test("the process default alone is enough to make it ask", async () => {
    process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE = "300";
    await withUpstreamPermit(
      connection({}),
      { kind: "interactive" },
      { holdMs: 1_000 },
      () => Promise.resolve(null),
    );
    expect(recorded.acquires).toBe(1);
  });
});

describe("the seat always comes back", () => {
  test("released after a normal call", async () => {
    await withUpstreamPermit(
      connection({ maxConcurrent: 1 }),
      { kind: "interactive" },
      { holdMs: 1_000 },
      () => Promise.resolve(null),
    );
    expect(recorded.releases).toHaveLength(1);
  });

  test("released after the call throws, and the error is the caller's", async () => {
    let message = "";
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "interactive" },
        { holdMs: 1_000 },
        () => Promise.reject(new Error("upstream said no")),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("upstream said no");
    expect(recorded.releases).toHaveLength(1);

    // Move the `govRelease` out of the `finally` and this is the case that
    // goes red — the happy path above would still pass.
  });
});

describe("a 429 is shared before it is raised", () => {
  test("the block is written, and the caller gets a message it can act on", async () => {
    let thrown: unknown;
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "interactive" },
        { holdMs: 1_000 },
        () =>
          Promise.reject(
            new UpstreamHttpError(
              429,
              { "retry-after": "45" },
              "EXTERNAL_APP_HTTP_FAILED: GET /things → 429: slow down",
            ),
          ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UpstreamRateLimitedError);
    expect(recorded.blocks).toEqual([{ scope: "conn", forMs: 45_000 }]);
    // Names the app and says what to do — "rate limited" alone is not
    // actionable by anyone who reads it.
    expect((thrown as Error).message).toContain("Acme");
    expect((thrown as Error).message).toContain("cacheTtlSeconds");
  });

  test("a failure that is NOT a refusal passes through untouched", async () => {
    let message = "";
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "interactive" },
        { holdMs: 1_000 },
        () =>
          Promise.reject(
            new UpstreamHttpError(500, {}, "EXTERNAL_APP_HTTP_FAILED: boom"),
          ),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("boom");
    expect(recorded.blocks).toEqual([]);
  });

  test("with no header to read, the policy's own default is the block", async () => {
    process.env.EXTERNAL_APP_DEFAULT_RETRY_AFTER_MS = "12000";
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "interactive" },
        { holdMs: 1_000 },
        () => Promise.reject(new Error("HTTP 429 Too Many Requests")),
      );
    } catch {
      // expected
    }
    expect(recorded.blocks).toEqual([{ scope: "conn", forMs: 12_000 }]);
    delete process.env.EXTERNAL_APP_DEFAULT_RETRY_AFTER_MS;
  });
});

describe("when the governor itself cannot be reached", () => {
  test("the call goes out unmetered rather than being refused", async () => {
    nextVerdict = "throw";
    const result = await withUpstreamPermit(
      connection({ maxConcurrent: 1 }),
      { kind: "interactive" },
      { holdMs: 1_000 },
      () => Promise.resolve("went anyway"),
    );
    expect(result).toBe("went anyway");
  });

  test("unless the deployment says it would rather stop", async () => {
    process.env.EXTERNAL_APP_GOVERNOR_FAIL_OPEN = "false";
    nextVerdict = "throw";
    let message = "";
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "interactive" },
        { holdMs: 1_000 },
        () => Promise.resolve("should not run"),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("ECONNREFUSED");
  });
});

describe("giving up on a permit", () => {
  test("an interactive caller stops at its wait budget and names the app", async () => {
    process.env.EXTERNAL_APP_MAX_WAIT_MS = "60";
    nextVerdict = { admitted: false, waitMs: 20, reason: "concurrency" };
    let thrown: unknown;
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "interactive" },
        { holdMs: 1_000 },
        () => Promise.resolve("never runs"),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UpstreamRateLimitedError);
    expect((thrown as Error).message).toContain("Acme");
    // It kept asking rather than giving up on the first refusal.
    expect(recorded.acquires).toBeGreaterThan(1);
    delete process.env.EXTERNAL_APP_MAX_WAIT_MS;
  });

  test("a background caller waits to ITS deadline, not to the interactive one", async () => {
    process.env.EXTERNAL_APP_MAX_WAIT_MS = "10000";
    nextVerdict = { admitted: false, waitMs: 20, reason: "conn_rate" };
    const startedAt = Date.now();
    try {
      await withUpstreamPermit(
        connection({ maxConcurrent: 1 }),
        { kind: "background", deadlineAt: Date.now() + 80 },
        { holdMs: 1_000 },
        () => Promise.resolve(null),
      );
    } catch {
      // expected
    }
    // Its own 80 ms, not the interactive 10 s the env just set.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    delete process.env.EXTERNAL_APP_MAX_WAIT_MS;
  });
});
