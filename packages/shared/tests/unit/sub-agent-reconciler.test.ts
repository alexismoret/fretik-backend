import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * The sweep's verdict on a sub-agent that never reported back.
 *
 * A sub-agent runs as a queue job on an AI replica and settles its own task.
 * Its row stays `pending` for good only if that never happens — its worker
 * died and the queue gave up, or the job was lost — and then the
 * conversation's resume, which waits for EVERY pending task, never comes. The
 * reconciler fails such a row. The ways to get it wrong are all silent:
 * killing a job merely waiting for a worker (no heartbeat yet), killing one a
 * dead worker held that the queue is about to hand to another replica, and
 * killing live runs because Redis hiccupped.
 *
 * Doubled at the process boundary (Redis).
 */

const store = new Map<string, string>();
let redisDown = false;
await mockModule("../../src/lib/redis", {
  redis: {
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    mget: async (...keys: string[]) => {
      if (redisDown) throw new Error("connection refused");
      return keys.map((key) => store.get(key) ?? null);
    },
  },
});

const { beatSubAgent, clearSubAgentHeartbeat, liveSubAgents } =
  await import("../../src/lib/sub-agent-heartbeat");
const { deadSubAgents } =
  await import("../../src/services/conversation-tasks/kinds");

const NOW = Date.parse("2026-09-26T12:00:00Z");
const row = (ref: string, ageMinutes: number) => ({
  ref,
  createdAt: new Date(NOW - ageMinutes * 60_000),
});
const none = new Set<string>();

beforeEach(() => {
  store.clear();
  redisDown = false;
});

describe("sub-agent reconciliation", () => {
  test("a run no worker holds and the queue no longer owes is dead; one still beating is not", async () => {
    await beatSubAgent("alive");
    const alive = await liveSubAgents(["alive", "dead"]);
    expect(
      deadSubAgents(
        [row("alive", 12), row("dead", 12)],
        { alive, owed: none },
        NOW,
      ),
    ).toEqual(["dead"]);
  });

  test("a job the queue still owes is not dead — until it has been owed absurdly long", () => {
    const owed = new Set(["queued", "lost"]);
    expect(
      deadSubAgents(
        [row("queued", 25), row("lost", 75)],
        { alive: none, owed },
        NOW,
      ),
    ).toEqual(["lost"]);
  });

  test("a run that finished cleanly leaves no heartbeat behind", async () => {
    await beatSubAgent("done");
    await clearSubAgentHeartbeat("done");
    expect((await liveSubAgents(["done"])).has("done")).toBe(false);
  });

  test("Redis down reads as alive, never as a batch of deaths", async () => {
    redisDown = true;
    const alive = await liveSubAgents(["a", "b"]);
    expect(
      deadSubAgents([row("a", 20), row("b", 20)], { alive, owed: none }, NOW),
    ).toEqual([]);
  });
});
