import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * The sweep's verdict on a background sub-agent that never reported back.
 *
 * Such a run lives only in the AI process that launched it; its task row stays
 * `pending` from launch to completion. The one way it stays pending for good is
 * that process dying mid-run — and then the conversation's resume, which waits
 * for EVERY pending task, never comes. The reconciler reads the run's
 * heartbeat: gone means dead, settled as failed so the conversation resumes
 * and the agent can re-dispatch. A Redis failure must NOT kill live runs.
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

const { beatSubAgent, clearSubAgentHeartbeat } =
  await import("../../src/lib/sub-agent-heartbeat");
const { CONVERSATION_TASK_RECONCILERS } =
  await import("../../src/services/conversation-tasks/kinds");

const reconcile = (refs: string[]) =>
  CONVERSATION_TASK_RECONCILERS.sub_agent.resolve(refs);

beforeEach(() => {
  store.clear();
  redisDown = false;
});

describe("background sub-agent reconciliation", () => {
  test("a run still beating is left alone; one that stopped is failed", async () => {
    await beatSubAgent("alive");
    const verdicts = await reconcile(["alive", "dead"]);
    expect([...verdicts]).toEqual([["dead", "failed"]]);
  });

  test("a run that finished cleanly leaves no heartbeat to wait out", async () => {
    await beatSubAgent("done");
    await clearSubAgentHeartbeat("done");
    // Its row is already settled, so the sweep never asks — but if it did,
    // the answer would be immediate rather than two minutes late.
    expect([...(await reconcile(["done"]))]).toEqual([["done", "failed"]]);
  });

  test("Redis down reads as alive, never as a batch of deaths", async () => {
    redisDown = true;
    expect((await reconcile(["a", "b"])).size).toBe(0);
  });
});
