import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "./mock-module";

/**
 * `withConnectionSlot` — one call at a time on a connection whose far side
 * cannot take two.
 *
 * The property that matters most is the NEGATIVE one: a normal provider must
 * pay nothing at all. If `parallel` ever started touching Redis, every read in
 * the product would grow a round trip to buy a guarantee only one app needs.
 */

interface RedisCall {
  op: string;
  key: string;
}

const calls: RedisCall[] = [];
/** Keys currently held, so `SET NX` behaves like the real thing. */
const held = new Set<string>();

await mockModule("../../src/lib/redis", {
  redis: {
    set: (key: string, _token: string, ..._rest: unknown[]) => {
      calls.push({ op: "set", key });
      if (held.has(key)) return Promise.resolve(null);
      held.add(key);
      return Promise.resolve("OK");
    },
    eval: (_lua: string, _n: number, key: string) => {
      calls.push({ op: "eval", key });
      held.delete(key);
      return Promise.resolve(1);
    },
  },
});

const providers: Record<string, unknown> = {};
await mockModule("../../src/external-apps/registry", {
  getProvider: (key: string) => providers[key],
});

const { ConnectionBusyError, isSerialConnection, withConnectionSlot } =
  await import("../../src/services/external-apps/exec/connection-slot");

const connection = (extra: {
  id?: string;
  providerKey?: string;
  concurrencyMode?: "parallel" | "serial" | null;
}) => ({
  id: extra.id ?? "conn-1",
  providerKey: extra.providerKey ?? "acme-wms",
  displayName: "Acme WMS",
  concurrencyMode: extra.concurrencyMode ?? null,
});

const declareSerial = (key: string, maxWaitMs = 8_000): void => {
  providers[key] = { manifest: { concurrency: { mode: "serial", maxWaitMs } } };
};

beforeEach(() => {
  calls.length = 0;
  held.clear();
  for (const key of Object.keys(providers)) delete providers[key];
});

describe("a parallel provider pays nothing", () => {
  test("no provider declaration means no Redis at all", async () => {
    const result = await withConnectionSlot(
      connection({}),
      () => Promise.resolve("done"),
      { leaseMs: 1_000 },
    );
    expect(result).toBe("done");
    expect(calls).toEqual([]);
  });

  test("an explicit parallel override skips the lock even on a serial provider", async () => {
    declareSerial("acme-wms");
    await withConnectionSlot(
      connection({ concurrencyMode: "parallel" }),
      () => Promise.resolve(null),
      { leaseMs: 1_000 },
    );
    expect(calls).toEqual([]);
  });
});

describe("a serial connection runs one at a time", () => {
  test("two concurrent calls do not overlap, and the key is the CONNECTION", async () => {
    declareSerial("acme-wms");
    let live = 0;
    let maxLive = 0;
    const call = () =>
      withConnectionSlot(
        connection({}),
        async () => {
          live += 1;
          maxLive = Math.max(maxLive, live);
          await new Promise((resolve) => setTimeout(resolve, 20));
          live -= 1;
        },
        { leaseMs: 1_000 },
      );

    await Promise.all([call(), call(), call()]);
    expect(maxLive).toBe(1);
    expect(calls.every((entry) => entry.key === "lock:ext-conn:conn-1")).toBe(
      true,
    );
  });

  test("two accounts on the same app never queue behind each other", async () => {
    declareSerial("acme-wms");
    let live = 0;
    let maxLive = 0;
    const call = (id: string) =>
      withConnectionSlot(
        connection({ id }),
        async () => {
          live += 1;
          maxLive = Math.max(maxLive, live);
          await new Promise((resolve) => setTimeout(resolve, 20));
          live -= 1;
        },
        { leaseMs: 1_000 },
      );

    await Promise.all([call("conn-a"), call("conn-b")]);
    expect(maxLive).toBe(2);
  });

  test("the slot is released even when the call throws", async () => {
    declareSerial("acme-wms");
    // Explicit try/catch, not `.rejects.toThrow()` — Bun types that matcher as
    // returning void, so the `await` the linter wants removed is the only thing
    // that makes it assert. See `episode-vectors-contract.test.ts`.
    let message = "";
    try {
      await withConnectionSlot(
        connection({}),
        () => Promise.reject(new Error("upstream said no")),
        { leaseMs: 1_000 },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("upstream said no");
    expect(held.size).toBe(0);
  });

  test("a connection may be serial with no manifest at all — the MCP case", async () => {
    const mcp = connection({
      providerKey: "notion-mcp-7f3a",
      concurrencyMode: "serial",
    });
    expect(isSerialConnection(mcp)).toBe(true);
    await withConnectionSlot(mcp, () => Promise.resolve(null), {
      leaseMs: 1_000,
    });
    expect(calls.some((entry) => entry.op === "set")).toBe(true);
  });
});

describe("giving up", () => {
  test("the wait budget runs out with a message naming the connection", async () => {
    declareSerial("acme-wms", 60);
    // Hold the slot for longer than any waiter's budget.
    const holder = withConnectionSlot(
      connection({}),
      () => new Promise((resolve) => setTimeout(resolve, 200)),
      { leaseMs: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    let thrown: unknown;
    try {
      await withConnectionSlot(
        connection({}),
        () => Promise.resolve("never runs"),
        { leaseMs: 5_000 },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectionBusyError);
    // Names the connection, because "something is busy" is not actionable.
    expect((thrown as Error).message).toContain("Acme WMS");
    await holder;
  });
});
