import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import { workflowRuns, workflows } from "../../../src/db/schema";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * The runaway guard and the queued-backlog cancel — the two halves of "stop
 * the flood".
 *
 * Both were unit-tested against a faked `db` until 2026-09-02, and the fake
 * made the central claim untestable: `cancelQueuedEventRuns` selects on FOUR
 * predicates (`workflowId`, `teamId`, `status = queued`, `triggerType =
 * event`), the whole point being that a running turn, a user's manual run and
 * another team's backlog are left alone — and the fake's `where: async () =>
 * queuedRuns` returned the fixture list for any of them. Every one of those
 * exclusions is now a row in Postgres that must survive the call.
 *
 * Trigger.dev and the AI service stay doubled: they are process boundaries, and
 * a test must not depend on a third party being reachable. Everything between
 * the guard and the table is real, `pauseWorkflow` → `deactivateWorkflow` →
 * `cancelQueuedEventRuns` → `finalizeRun` included, so the transition race and
 * the domain-event journalling run for real too.
 */

const triggerCancelCalls: string[] = [];
let triggerCancelFails = false;

await mockModule("../../../src/lib/trigger-client", {
  cancelWorkflowTriggerRun: (triggerRunId: string) => {
    triggerCancelCalls.push(triggerRunId);
    if (triggerCancelFails)
      return Promise.reject(new Error("trigger API down"));
    return Promise.resolve();
  },
  deleteWorkflowSchedule: () => Promise.resolve(),
});

// The searchable card is refreshed fire-and-forget through the AI service on
// every deactivation. Unreachable here by design (the preload points it at a
// dead port), and a `void`ed rejection is an unhandled rejection, not a
// warning — so the boundary is doubled rather than left to fail quietly.
await mockModule("../../../src/lib/ai-service", {
  callAiService: () => Promise.resolve({ success: true }),
});

const { RUNAWAY_REASON_PREFIX, tripRunawayGuard } =
  await import("../../../src/services/workflows/trip-runaway-guard");
const { cancelQueuedEventRuns } =
  await import("../../../src/services/workflows/cancel-queued-event-runs");

const PLAYBOOK: WorkflowPlaybook = {
  goal: "keep the integration suite honest",
  tasks: [
    {
      key: "only-task",
      title: "Do the thing",
      description: "",
      instructions: "Do the thing exactly once.",
    },
  ],
};

let fx: WorkspaceFixture;

const createWorkflow = async (
  status: "active" | "paused" = "active",
): Promise<string> => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      name: "Runaway subject",
      triggerType: "event",
      playbook: PLAYBOOK,
      status,
      createdByUserId: fx.userIds[0],
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("failed to insert workflow");
  return row.id;
};

const createRun = async (
  workflowId: string,
  overrides: Partial<typeof workflowRuns.$inferInsert> = {},
): Promise<string> => {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      workflowId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      triggerType: "event",
      status: "queued",
      ...overrides,
    })
    .returning({ id: workflowRuns.id });
  if (!row) throw new Error("failed to insert workflow run");
  return row.id;
};

const statusOf = async (runId: string): Promise<string> => {
  const row = await db.query.workflowRuns.findFirst({
    where: { id: runId },
    columns: { status: true },
  });
  if (!row) throw new Error(`run ${runId} disappeared`);
  return row.status;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(() => {
  triggerCancelCalls.length = 0;
  triggerCancelFails = false;
});

describe("tripRunawayGuard", () => {
  test("pauses an active workflow and stamps the runaway:<cap> reason", async () => {
    const workflowId = await createWorkflow("active");
    await tripRunawayGuard({ workflowId, teamId: fx.teamId, cap: 1000 });

    const row = await db.query.workflows.findFirst({
      where: { id: workflowId },
      columns: { status: true, pausedReason: true },
    });
    expect(row?.status).toBe("paused");
    expect(row?.pausedReason).toBe(`${RUNAWAY_REASON_PREFIX}:1000`);
  });

  test("no-ops when the workflow is already non-active (concurrent trippers)", async () => {
    const workflowId = await createWorkflow("paused");
    await tripRunawayGuard({ workflowId, teamId: fx.teamId, cap: 1000 });

    const row = await db.query.workflows.findFirst({
      where: { id: workflowId },
      columns: { pausedReason: true },
    });
    // The second tripper must not overwrite the first one's reason — nor
    // stamp one where a plain manual pause deliberately left none.
    expect(row?.pausedReason).toBeNull();
  });

  test("no-ops when the workflow is gone", async () => {
    await tripRunawayGuard({
      workflowId: "00000000-0000-4000-8000-00000000dead",
      teamId: fx.teamId,
      cap: 1000,
    });
  });

  test("the pause takes the queued event backlog with it", async () => {
    // The two halves, joined: this is the path the guard actually walks in
    // production, and nothing before today exercised it end to end.
    const workflowId = await createWorkflow("active");
    const queued = await createRun(workflowId, { triggerRunId: "trig_storm" });
    await tripRunawayGuard({ workflowId, teamId: fx.teamId, cap: 1000 });

    expect(await statusOf(queued)).toBe("canceled");
    expect(triggerCancelCalls).toEqual(["trig_storm"]);
  });
});

describe("cancelQueuedEventRuns", () => {
  test("cancels the Trigger run when present and finalizes every candidate", async () => {
    const workflowId = await createWorkflow();
    const withTrigger = await createRun(workflowId, {
      triggerRunId: "trig_1",
    });
    const withoutTrigger = await createRun(workflowId);

    const canceled = await cancelQueuedEventRuns({
      workflowId,
      teamId: fx.teamId,
    });
    expect(canceled).toBe(2);
    expect(triggerCancelCalls).toEqual(["trig_1"]);
    expect(await statusOf(withTrigger)).toBe("canceled");
    expect(await statusOf(withoutTrigger)).toBe("canceled");
  });

  test("a Trigger cancel failure is best-effort — the run is still finalized", async () => {
    const workflowId = await createWorkflow();
    const run = await createRun(workflowId, { triggerRunId: "trig_1" });
    triggerCancelFails = true;

    const canceled = await cancelQueuedEventRuns({
      workflowId,
      teamId: fx.teamId,
    });
    expect(canceled).toBe(1);
    expect(await statusOf(run)).toBe("canceled");
  });

  test("only runs whose terminal transition this call won are counted", async () => {
    const workflowId = await createWorkflow();
    const live = await createRun(workflowId);
    const alreadyDone = await createRun(workflowId);
    // The loser of the race, expressed as the state that produces it rather
    // than as a stubbed return value: a row that is already terminal matches
    // zero rows in `finalizeRun`'s guarded UPDATE.
    await db
      .update(workflowRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(workflowRuns.id, alreadyDone));

    const canceled = await cancelQueuedEventRuns({
      workflowId,
      teamId: fx.teamId,
    });
    expect(canceled).toBe(1);
    expect(await statusOf(live)).toBe("canceled");
    expect(await statusOf(alreadyDone)).toBe("succeeded");
  });

  test("an empty backlog is a no-op", async () => {
    const workflowId = await createWorkflow();
    expect(await cancelQueuedEventRuns({ workflowId, teamId: fx.teamId })).toBe(
      0,
    );
    expect(triggerCancelCalls).toEqual([]);
  });

  describe("what the four-predicate WHERE deliberately spares", () => {
    test("a RUNNING run keeps its lifecycle", async () => {
      const workflowId = await createWorkflow();
      const running = await createRun(workflowId, { status: "running" });
      expect(
        await cancelQueuedEventRuns({ workflowId, teamId: fx.teamId }),
      ).toBe(0);
      expect(await statusOf(running)).toBe("running");
    });

    test("a run waiting on an approval keeps its lifecycle", async () => {
      const workflowId = await createWorkflow();
      const parked = await createRun(workflowId, { status: "needs_approval" });
      expect(
        await cancelQueuedEventRuns({ workflowId, teamId: fx.teamId }),
      ).toBe(0);
      expect(await statusOf(parked)).toBe("needs_approval");
    });

    test("a user-initiated run is not part of the flood", async () => {
      // manual / test / form runs are seconds from starting and somebody is
      // watching them. Killing those on a pause is the difference between
      // "stopped the storm" and "cancelled the run I just launched".
      const workflowId = await createWorkflow();
      const manual = await createRun(workflowId, { triggerType: "manual" });
      const form = await createRun(workflowId, { triggerType: "form" });
      expect(
        await cancelQueuedEventRuns({ workflowId, teamId: fx.teamId }),
      ).toBe(0);
      expect(await statusOf(manual)).toBe("queued");
      expect(await statusOf(form)).toBe("queued");
    });

    test("another workflow's backlog is untouched", async () => {
      const mine = await createWorkflow();
      const theirs = await createWorkflow();
      const spared = await createRun(theirs);
      await createRun(mine);
      expect(
        await cancelQueuedEventRuns({ workflowId: mine, teamId: fx.teamId }),
      ).toBe(1);
      expect(await statusOf(spared)).toBe("queued");
    });

    test("another team cannot cancel this team's backlog", async () => {
      const workflowId = await createWorkflow();
      const run = await createRun(workflowId);
      const other = await createWorkspaceFixture();
      try {
        expect(
          await cancelQueuedEventRuns({ workflowId, teamId: other.teamId }),
        ).toBe(0);
        expect(await statusOf(run)).toBe("queued");
      } finally {
        await other.cleanup();
      }
    });
  });
});
