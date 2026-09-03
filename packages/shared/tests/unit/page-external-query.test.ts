import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()`; the method exists only once `@hono/zod-openapi` has patched Zod.
import "@hono/zod-openapi";
import { mockModule } from "../lib/mock-module";

/**
 * What a page dataset does with an app that answers SLOWLY — the only part of
 * `exec/page-query.ts` that is neither a transport nor a query.
 *
 * Written for a measured failure (Langfuse `01a03e9b…`, Akanea WMS): every read
 * took 12-15 s, the page-side wait was 10 s, and the answer that arrived at 13 s
 * was dropped on the floor. Every render started cold and failed identically —
 * in the app AND in the review harness, which reads the same fixtures — so the
 * builder concluded the app was unreachable and shipped invented rows.
 *
 * The doubles here are the process boundaries only: Redis, the connection
 * lookup, the tool snapshot, and the MCP socket. Everything the assertions
 * exercise — the wait, the shared run budget, the in-flight join, the cache
 * write — is the real module.
 */

/** Minimal Redis: the four calls this path makes, and no behaviour of its own. */
const store = new Map<string, string>();
const counters = new Map<string, number>();
const redisFake = {
  get: (key: string): Promise<string | null> =>
    Promise.resolve(store.get(key) ?? null),
  set: (key: string, value: string): Promise<"OK"> => {
    store.set(key, value);
    return Promise.resolve("OK");
  },
  incr: (key: string): Promise<number> => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return Promise.resolve(next);
  },
  expire: (): Promise<number> => Promise.resolve(1),
};

/** An MCP connection: `mcpAuthKind` non-null is the discriminator. */
const connection = {
  id: "conn-slow",
  providerKey: "slow-app",
  displayName: "Slow App",
  mcpAuthKind: "bearer",
  actionPolicies: null,
  toolFingerprint: "fp-1",
};

const snapshot = {
  descriptor: {
    actions: [
      {
        name: "list_orders",
        kind: "read",
        mcpToolName: "list_orders",
        approvalDefault: "auto",
      },
    ],
  },
};

/**
 * The upstream call, held open until a test lets it land. Answers in the shape
 * an MCP tool really returns, so `normalizeMcpResult` stays real.
 */
let upstreamCalls = 0;
let settle: (result: unknown) => void = () => undefined;
let pending = new Promise<unknown>((resolve) => {
  settle = resolve;
});
const restartUpstream = (): void => {
  pending = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
};
const land = (rows: unknown[]): void => {
  settle({ content: [{ type: "text", text: JSON.stringify(rows) }] });
};

await mockModule("../../src/lib/redis", { redis: redisFake });
await mockModule(
  "../../src/services/external-apps/connections/resolve-for-page",
  {
    resolvePageConnection: () => Promise.resolve({ status: "ok", connection }),
  },
);
await mockModule("../../src/services/external-apps/mcp/snapshot-store", {
  getSnapshotForConnection: () => Promise.resolve(snapshot),
});
await mockModule("../../src/services/external-apps/mcp/transport", {
  mcpCallTool: async (): Promise<unknown> => {
    upstreamCalls += 1;
    return await pending;
  },
});

const { externalPageQueryExecutor } =
  await import("../../src/services/external-apps/exec/page-query");

/** `question` only varies the cache key — one operation, distinct arguments. */
const ask = (extra: { deadlineAt?: number; question?: string } = {}) =>
  externalPageQueryExecutor.execute({
    teamId: "team-1",
    userId: "user-1",
    operation: "list_orders",
    args: { q: extra.question ?? "all" },
    ...(extra.deadlineAt !== undefined ? { deadlineAt: extra.deadlineAt } : {}),
  });

/** Wait for a condition the module reaches on its own, without a fixed sleep. */
const until = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop -- polling is the point
    await Bun.sleep(10);
  }
};

const rowsOf = (result: Awaited<ReturnType<typeof ask>>): unknown[] =>
  result.status === "ok" ? result.rows : [];

describe("a page dataset over a slow app", () => {
  test("an answer that lands after the wait fills the cache instead of being lost", async () => {
    restartUpstream();
    store.clear();
    const before = upstreamCalls;
    const question = "late-answer";
    const askedAt = Date.now();
    // A wait just over the floor: the call is worth starting, and it will not
    // finish inside it.
    const first = await ask({ question, deadlineAt: askedAt + 3_050 });

    expect(Date.now() - askedAt).toBeGreaterThanOrEqual(3_000);
    expect(first.status).toBe("error");
    if (first.status === "error") {
      expect(first.message).toContain("still working");
      expect(first.retryAfterMs).toBeGreaterThan(0);
    }
    expect(upstreamCalls).toBe(before + 1);

    // The app answers with nobody waiting for it.
    land([{ id: "o-1" }]);
    await until(() => store.size > 0, "the late answer to reach the cache");

    const second = await ask({ question });
    expect(second.status).toBe("ok");
    expect(rowsOf(second)).toEqual([{ id: "o-1" }]);
    // The point: the second read was served by the answer the first one paid
    // for. A wait that abandons its work asks the app all over again.
    expect(upstreamCalls).toBe(before + 1);
  });

  test("a second reader joins the run instead of asking the app twice", async () => {
    restartUpstream();
    store.clear();
    const before = upstreamCalls;
    const question = "joined";

    const both = Promise.all([ask({ question }), ask({ question })]);
    await until(
      () => upstreamCalls === before + 1,
      "the upstream call to start",
    );
    land([{ id: "o-2" }]);
    const [one, two] = await both;

    expect(upstreamCalls).toBe(before + 1);
    expect(rowsOf(one)).toEqual([{ id: "o-2" }]);
    expect(rowsOf(two)).toEqual([{ id: "o-2" }]);
  });

  test("a dataset whose turn comes after the run's budget is spent is never asked", async () => {
    restartUpstream();
    store.clear();
    const before = upstreamCalls;

    const result = await ask({
      question: "too-late",
      deadlineAt: Date.now() + 500,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("spent its budget");
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
    // No licence seat taken, no minute of budget spent, on a question that
    // could not have been answered in what was left.
    expect(upstreamCalls).toBe(before);
  });
});
