import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "./mock-module";

// ---------------------------------------------------------------- //
// Runaway guard + queued-backlog cancel: the pause must stamp the   //
// `runaway:<cap>` reason exactly once (idempotent on non-active     //
// workflows), and the bulk cancel must finalize every queued event  //
// run even when the Trigger.dev cancel call fails (best-effort),    //
// while only counting runs whose terminal transition it won.        //
// The db, pause service, trigger client and finalize are mocked at  //
// module level — dynamic imports below resolve AFTER.               //
// ---------------------------------------------------------------- //

let workflowRow: { status: string } | undefined;
let queuedRuns: { id: string; triggerRunId: string | null }[] = [];
const pauseCalls: { id: string; teamId: string; reason?: string | null }[] = [];
const triggerCancelCalls: string[] = [];
const finalizeCalls: { runId: string; status: string }[] = [];
let triggerCancelFails = false;
/** Run ids whose finalize loses the transition race (already terminal). */
let alreadyTerminal = new Set<string>();

await mockModule("../../src/db", {
  default: {
    query: new Proxy(
      {},
      {
        get: () => ({
          findFirst: async () => workflowRow,
          findMany: async () => [],
        }),
      },
    ),
    select: () => ({
      from: () => ({
        where: async () => queuedRuns,
      }),
    }),
  },
});

await mockModule("../../src/services/workflows/pause", {
  pauseWorkflow: async (params: {
    id: string;
    teamId: string;
    reason?: string | null;
  }) => {
    pauseCalls.push(params);
    return undefined;
  },
});

// Only the one call under test is replaced: `mockModule` keeps the rest of
// the client's surface, so the mirror this used to hand-maintain is gone.
await mockModule("../../src/lib/trigger-client", {
  cancelWorkflowTriggerRun: async (triggerRunId: string) => {
    triggerCancelCalls.push(triggerRunId);
    if (triggerCancelFails) throw new Error("trigger API down");
  },
});

await mockModule("../../src/services/workflows/finalize-run", {
  finalizeRun: async (params: { runId: string; status: string }) => {
    finalizeCalls.push(params);
    return { transitioned: !alreadyTerminal.has(params.runId) };
  },
});

const { tripRunawayGuard, RUNAWAY_REASON_PREFIX } =
  await import("../../src/services/workflows/trip-runaway-guard");
const { cancelQueuedEventRuns } =
  await import("../../src/services/workflows/cancel-queued-event-runs");

beforeEach(() => {
  workflowRow = undefined;
  queuedRuns = [];
  pauseCalls.length = 0;
  triggerCancelCalls.length = 0;
  finalizeCalls.length = 0;
  triggerCancelFails = false;
  alreadyTerminal = new Set();
});

describe("tripRunawayGuard", () => {
  test("pauses an active workflow with the runaway:<cap> reason", async () => {
    workflowRow = { status: "active" };
    await tripRunawayGuard({ workflowId: "wf1", teamId: "t1", cap: 1000 });
    expect(pauseCalls).toEqual([
      { id: "wf1", teamId: "t1", reason: `${RUNAWAY_REASON_PREFIX}:1000` },
    ]);
  });

  test("no-ops when the workflow is already non-active (concurrent trippers)", async () => {
    workflowRow = { status: "paused" };
    await tripRunawayGuard({ workflowId: "wf1", teamId: "t1", cap: 1000 });
    expect(pauseCalls).toEqual([]);
  });

  test("no-ops when the workflow is gone", async () => {
    workflowRow = undefined;
    await tripRunawayGuard({ workflowId: "wf1", teamId: "t1", cap: 1000 });
    expect(pauseCalls).toEqual([]);
  });
});

describe("cancelQueuedEventRuns", () => {
  test("cancels the Trigger run when present and finalizes every candidate", async () => {
    queuedRuns = [
      { id: "r1", triggerRunId: "trig_1" },
      { id: "r2", triggerRunId: null },
    ];
    const canceled = await cancelQueuedEventRuns({
      workflowId: "wf1",
      teamId: "t1",
    });
    expect(canceled).toBe(2);
    expect(triggerCancelCalls).toEqual(["trig_1"]);
    expect(finalizeCalls.map((c) => c.runId).sort()).toEqual(["r1", "r2"]);
    expect(finalizeCalls.every((c) => c.status === "canceled")).toBe(true);
  });

  test("a Trigger cancel failure is best-effort — the run is still finalized", async () => {
    queuedRuns = [{ id: "r1", triggerRunId: "trig_1" }];
    triggerCancelFails = true;
    const canceled = await cancelQueuedEventRuns({
      workflowId: "wf1",
      teamId: "t1",
    });
    expect(canceled).toBe(1);
    expect(finalizeCalls.map((c) => c.runId)).toEqual(["r1"]);
  });

  test("only runs whose terminal transition this call won are counted", async () => {
    queuedRuns = [
      { id: "r1", triggerRunId: null },
      { id: "r2", triggerRunId: null },
    ];
    alreadyTerminal = new Set(["r2"]);
    const canceled = await cancelQueuedEventRuns({
      workflowId: "wf1",
      teamId: "t1",
    });
    expect(canceled).toBe(1);
    expect(finalizeCalls.map((c) => c.runId).sort()).toEqual(["r1", "r2"]);
  });

  test("an empty backlog is a no-op", async () => {
    const canceled = await cancelQueuedEventRuns({
      workflowId: "wf1",
      teamId: "t1",
    });
    expect(canceled).toBe(0);
    expect(finalizeCalls).toEqual([]);
    expect(triggerCancelCalls).toEqual([]);
  });
});
