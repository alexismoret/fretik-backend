import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import db from "../../../src/db";
import { workflowRuns, workflows } from "../../../src/db/schema";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Parking on a human, and coming back from it.
 *
 * Self-hosted Trigger.dev has no checkpoints, so an orchestrator waiting on
 * an approval stays EXECUTING and holds its workflow's concurrency slot for
 * the whole wait — three parked runs at a limit of three stopped a live
 * workflow for six days on 2026-09-22. The orchestrator therefore ENDS at a
 * park and a fresh one resumes it, which moves the entire hand-off into
 * these columns: `resume_from_turn_index` / `resume_remaining_ms`, and the
 * `WHERE` clauses that claim them.
 *
 * Every claim here lives in a predicate, so every test is a row in Postgres:
 *  - the park refuses a run that already parked (the approval email's
 *    exactly-once signal),
 *  - the resume can be won exactly ONCE even by concurrent deciders,
 *  - the resume carries the turn index and the REMAINING budget forward,
 *  - a park nobody answers is closed by the sweeper, which is now the only
 *    bound left on it (the wait token's `timeout: 7d` went with the token).
 *
 * Trigger.dev stays doubled — a process boundary, and the test must not
 * depend on it being reachable. Everything between the service and the table
 * is real, `finalizeRun` and its journalling included.
 */

interface TriggerCall {
  runId: string;
  startTurnIndex: number;
  remainingMs: number | undefined;
  idempotencyKey: string | undefined;
}

const triggerCalls: TriggerCall[] = [];
const cancelledTriggerRuns: string[] = [];
let triggerFails = false;
let cancelFails = false;
let nextTriggerRunId = "run_resumed";

await mockModule("../../../src/lib/trigger-client", {
  triggerWorkflowRun: (
    payload: {
      runId: string;
      startTurnIndex: number;
      remainingMs?: number;
    },
    opts: { idempotencyKey?: string },
  ) => {
    triggerCalls.push({
      runId: payload.runId,
      startTurnIndex: payload.startTurnIndex,
      remainingMs: payload.remainingMs,
      idempotencyKey: opts.idempotencyKey,
    });
    if (triggerFails) return Promise.reject(new Error("trigger API down"));
    return Promise.resolve({
      runId: nextTriggerRunId,
      publicAccessToken: "tok",
    });
  },
  cancelWorkflowTriggerRun: (triggerRunId: string) => {
    cancelledTriggerRuns.push(triggerRunId);
    if (cancelFails) return Promise.reject(new Error("trigger API down"));
    return Promise.resolve();
  },
});

// Fire-and-forget calls the terminal paths make. Unreachable here by design
// (the preload points them at a dead port), and a `void`ed rejection is an
// unhandled rejection rather than a warning.
await mockModule("../../../src/lib/ai-service", {
  callAiService: () => Promise.resolve({ success: true }),
});

const { parkRunForApproval } =
  await import("../../../src/services/workflows/heartbeat-run");
const { resumeRunFromApproval } =
  await import("../../../src/services/workflows/resume-from-approval");
const { markStalledRuns, WORKFLOW_APPROVAL_TIMEOUT_MINUTES } =
  await import("../../../src/services/workflows/mark-stalled-runs");
const { convertLegacyApprovalParks, MIN_PARK_AGE_MINUTES } =
  await import("../../../src/services/workflows/convert-legacy-approval-parks");

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
let workflowId: string;

/** A run parked on a human, exactly as the orchestrator leaves it. */
const createParkedRun = async (
  overrides: Partial<typeof workflowRuns.$inferInsert> = {},
): Promise<{ runId: string; conversationId: string }> => {
  const conversation = await fx.createConversation({ agentType: "workflow" });
  const [row] = await db
    .insert(workflowRuns)
    .values({
      workflowId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      triggerType: "event",
      status: "needs_approval",
      conversationId: conversation.id,
      triggerRunId: "run_parked",
      pausedAt: new Date(),
      resumeFromTurnIndex: 4,
      resumeRemainingMs: 90_000,
      ...overrides,
    })
    .returning({ id: workflowRuns.id });
  if (!row) throw new Error("failed to insert workflow run");
  return { runId: row.id, conversationId: conversation.id };
};

const readRun = async (runId: string) => {
  const row = await db.query.workflowRuns.findFirst({
    where: { id: runId },
    columns: {
      status: true,
      triggerRunId: true,
      resumeFromTurnIndex: true,
      resumeRemainingMs: true,
      pausedAt: true,
      pausedMs: true,
      error: true,
    },
  });
  if (!row) throw new Error(`run ${runId} disappeared`);
  return row;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      name: "Approval subject",
      triggerType: "event",
      playbook: PLAYBOOK,
      status: "active",
      createdByUserId: fx.userIds[0],
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("failed to insert workflow");
  workflowId = row.id;
});

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(() => {
  triggerCalls.length = 0;
  cancelledTriggerRuns.length = 0;
  triggerFails = false;
  cancelFails = false;
  nextTriggerRunId = "run_resumed";
});

describe("parkRunForApproval", () => {
  test("records the resume point on a running run", async () => {
    const { runId } = await createParkedRun({
      status: "running",
      resumeFromTurnIndex: null,
      resumeRemainingMs: null,
      pausedAt: null,
    });

    const { parked } = await parkRunForApproval({
      runId,
      resumeFromTurnIndex: 7,
      remainingMs: 12_345,
    });

    expect(parked).toBe(true);
    const row = await readRun(runId);
    expect(row.status).toBe("needs_approval");
    expect(row.resumeFromTurnIndex).toBe(7);
    expect(row.resumeRemainingMs).toBe(12_345);
  });

  test("refuses a run that already parked — the email's exactly-once signal", async () => {
    // A retried callback from the orchestrator must not make the approval
    // email fire twice, and must not move the resume point of a park a
    // decision may already be acting on.
    const { runId } = await createParkedRun();

    const { parked } = await parkRunForApproval({
      runId,
      resumeFromTurnIndex: 99,
      remainingMs: 1,
    });

    expect(parked).toBe(false);
    const row = await readRun(runId);
    expect(row.resumeFromTurnIndex).toBe(4);
  });

  test("refuses a terminal run — a canceled run is never dragged back", async () => {
    const { runId } = await createParkedRun({
      status: "canceled",
      resumeFromTurnIndex: null,
      resumeRemainingMs: null,
    });

    const { parked } = await parkRunForApproval({
      runId,
      resumeFromTurnIndex: 2,
      remainingMs: 1,
    });

    expect(parked).toBe(false);
    expect((await readRun(runId)).status).toBe("canceled");
  });
});

describe("resumeRunFromApproval", () => {
  test("starts a fresh orchestrator at the recorded turn, on the REMAINING budget", async () => {
    const { runId, conversationId } = await createParkedRun();

    const resumed = await resumeRunFromApproval({
      conversationId,
      decision: "approved",
    });

    expect(resumed).toBe(true);
    expect(triggerCalls).toHaveLength(1);
    // The turn index is a correctness field: the AI service replays a
    // recorded verdict for any turnIndex <= lastTurnIndex, so resuming at
    // the wrong one silently re-runs nothing.
    expect(triggerCalls[0]?.startTurnIndex).toBe(4);
    // And the budget is what was LEFT — not a fresh hour per approval.
    expect(triggerCalls[0]?.remainingMs).toBe(90_000);

    const row = await readRun(runId);
    expect(row.status).toBe("running");
    expect(row.triggerRunId).toBe("run_resumed");
    // Claimed: the resume point is consumed, so nothing can resume twice.
    expect(row.resumeFromTurnIndex).toBeNull();
    expect(row.resumeRemainingMs).toBeNull();
    // The park window is banked rather than charged to the run as work.
    expect(row.pausedAt).toBeNull();
    expect(row.pausedMs).toBeGreaterThanOrEqual(0);
  });

  test("two concurrent decisions start exactly ONE orchestrator", async () => {
    // The failure this shape exists to prevent: a double-submit or a retried
    // callback each reading a parked run and each launching a loop, so two
    // orchestrators drive one run. The claim is a `WHERE ... IS NOT NULL`;
    // delete it and this goes red.
    const { runId, conversationId } = await createParkedRun();

    const outcomes = await Promise.all([
      resumeRunFromApproval({ conversationId, decision: "approved" }),
      resumeRunFromApproval({ conversationId, decision: "approved" }),
      resumeRunFromApproval({ conversationId, decision: "approved" }),
      resumeRunFromApproval({ conversationId, decision: "approved" }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(triggerCalls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("running");
  });

  test("a run that is not parked is left alone", async () => {
    const { conversationId } = await createParkedRun({
      status: "running",
      resumeFromTurnIndex: null,
      resumeRemainingMs: null,
      pausedAt: null,
    });

    expect(
      await resumeRunFromApproval({ conversationId, decision: "approved" }),
    ).toBe(false);
    expect(triggerCalls).toHaveLength(0);
  });

  test("a park with no resume point starts NOTHING", async () => {
    // Two ways to be here, both transient: a run parked by the old
    // orchestrator before `convert-legacy-approval-parks.ts` ran, and the
    // sub-second window where the turn wrote `needs_approval` but the
    // orchestrator's `/park` has not landed. Launching without a turn index
    // would replay the run from turn 1 — the playbook a second time.
    const { conversationId } = await createParkedRun({
      resumeFromTurnIndex: null,
      resumeRemainingMs: null,
    });

    expect(
      await resumeRunFromApproval({ conversationId, decision: "approved" }),
    ).toBe(false);
    expect(triggerCalls).toHaveLength(0);
  });

  test("a trigger that fails closes the run instead of leaving a zombie", async () => {
    // The claim has already moved the run to `running`. Without this the run
    // sits there with no orchestrator until the stall sweeper notices, 20
    // minutes later, and the user sees a spinner the whole time.
    triggerFails = true;
    const { runId, conversationId } = await createParkedRun();

    expect(
      await resumeRunFromApproval({ conversationId, decision: "approved" }),
    ).toBe(false);

    const row = await readRun(runId);
    expect(row.status).toBe("failed");
    expect(row.error?.code).toBe("TRIGGER_FAILED");
  });
});

describe("markStalledRuns — the park's only remaining bound", () => {
  test("closes an approval nobody answered within the timeout", async () => {
    // This deadline used to be the wait token's `timeout: 7d`. The token is
    // gone, so if this predicate goes, a forgotten approval parks a run
    // forever and nothing ever says so.
    const asked = new Date(
      Date.now() - (WORKFLOW_APPROVAL_TIMEOUT_MINUTES + 60) * 60_000,
    );
    const { runId } = await createParkedRun({ pausedAt: asked });

    await markStalledRuns();

    const row = await readRun(runId);
    expect(row.status).toBe("failed");
    expect(row.error?.code).toBe("APPROVAL_TIMEOUT");
  });

  test("leaves an approval that is still within the timeout parked", async () => {
    const asked = new Date(
      Date.now() - (WORKFLOW_APPROVAL_TIMEOUT_MINUTES - 60) * 60_000,
    );
    const { runId } = await createParkedRun({ pausedAt: asked });

    await markStalledRuns();

    expect((await readRun(runId)).status).toBe("needs_approval");
  });

  test("never kills a parked run for a stale heartbeat", async () => {
    // There is no orchestrator at all while a run waits on a human, so its
    // heartbeat is necessarily ancient. The stall check must keep filtering
    // on `status = 'running'`, or every approval dies after 20 minutes.
    const { runId } = await createParkedRun({
      pausedAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() - 24 * 60 * 60_000),
      startedAt: new Date(Date.now() - 24 * 60 * 60_000),
    });

    await markStalledRuns();

    expect((await readRun(runId)).status).toBe("needs_approval");
  });
});

describe("convertLegacyApprovalParks", () => {
  /** A park left by the OLD orchestrator: no resume point, a live Trigger
   * run still holding the workflow's concurrency slot. */
  const createLegacyPark = async (
    overrides: Partial<typeof workflowRuns.$inferInsert> = {},
  ) =>
    createParkedRun({
      resumeFromTurnIndex: null,
      resumeRemainingMs: null,
      triggerRunId: "run_legacy",
      lastTurnIndex: 6,
      // The shape of the production rows: worked a few minutes, then parked
      // for a week. `pausedAt - startedAt` is the WORKED time precisely
      // because the park that is still open has not been banked yet.
      startedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000 - 6 * 60_000),
      pausedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000),
      pausedMs: 0,
      ...overrides,
    });

  test("cancels the stuck orchestrator and writes the resume point", async () => {
    const { runId } = await createLegacyPark();

    const report = await convertLegacyApprovalParks({ apply: true });

    expect(report.map((r) => r.runId)).toContain(runId);
    // Cancelling is the ONLY thing that frees the slot — the whole point of
    // the conversion. Completing the token instead would resume the playbook
    // on the old code.
    expect(cancelledTriggerRuns).toContain("run_legacy");

    const row = await readRun(runId);
    expect(row.status).toBe("needs_approval");
    expect(row.resumeFromTurnIndex).toBe(7);
    // 60 min of budget minus the 6 worked before the park — NOT minus the
    // week spent waiting on a human, which is the whole distinction.
    expect(row.resumeRemainingMs).toBe(54 * 60_000);
    // The cancelled Trigger run must not stay addressable: the Stop button
    // would otherwise try to cancel an already-dead run on every parked row.
    expect(row.triggerRunId).toBeNull();
  });

  test("a run that had already burned its budget gets zero, never a fresh one", async () => {
    const { runId } = await createLegacyPark({
      startedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000 - 90 * 60_000),
      pausedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000),
    });

    await convertLegacyApprovalParks({ apply: true });

    // Zero closes the run on TIME_LIMIT at the first turn — loud and finite.
    // A fresh 60 minutes would let a run be extended forever by answering it.
    expect((await readRun(runId)).resumeRemainingMs).toBe(0);
  });

  test("the converted run is then resumable — the two halves joined", async () => {
    const { runId, conversationId } = await createLegacyPark({
      lastTurnIndex: 11,
    });

    await convertLegacyApprovalParks({ apply: true });
    expect(
      await resumeRunFromApproval({ conversationId, decision: "approved" }),
    ).toBe(true);

    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0]?.startTurnIndex).toBe(12);
    expect((await readRun(runId)).status).toBe("running");
  });

  test("a dry run writes nothing", async () => {
    const { runId } = await createLegacyPark();

    const report = await convertLegacyApprovalParks({ apply: false });

    expect(report.map((r) => r.runId)).toContain(runId);
    expect(cancelledTriggerRuns).toHaveLength(0);
    const row = await readRun(runId);
    expect(row.resumeFromTurnIndex).toBeNull();
    expect(row.triggerRunId).toBe("run_legacy");
  });

  test("is idempotent — a second pass finds nothing", async () => {
    await createLegacyPark();

    await convertLegacyApprovalParks({ apply: true });
    cancelledTriggerRuns.length = 0;
    const second = await convertLegacyApprovalParks({ apply: true });

    expect(second).toHaveLength(0);
    expect(cancelledTriggerRuns).toHaveLength(0);
  });

  test("converts even when the cancel call fails", async () => {
    // A Trigger run the API no longer knows about holds no slot, which is
    // the outcome wanted. Refusing to convert would strand the row forever.
    cancelFails = true;
    const { runId } = await createLegacyPark();

    const report = await convertLegacyApprovalParks({ apply: true });

    expect(report.find((r) => r.runId === runId)?.cancelError).toBe(
      "trigger API down",
    );
    expect((await readRun(runId)).resumeFromTurnIndex).toBe(7);
  });

  test("NEVER touches a run that parked moments ago", async () => {
    // The candidate predicate also matches, for a fraction of a second, a
    // healthy run under the new code whose `/park` callback has not landed
    // yet. Cancelling that would kill a live orchestrator. Delete the age
    // predicate and this goes red.
    const { runId } = await createLegacyPark({
      pausedAt: new Date(Date.now() - (MIN_PARK_AGE_MINUTES - 5) * 60_000),
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    const report = await convertLegacyApprovalParks({ apply: true });

    expect(report.map((r) => r.runId)).not.toContain(runId);
    expect(cancelledTriggerRuns).toHaveLength(0);
    const row = await readRun(runId);
    expect(row.resumeFromTurnIndex).toBeNull();
    expect(row.triggerRunId).toBe("run_legacy");
  });
});
