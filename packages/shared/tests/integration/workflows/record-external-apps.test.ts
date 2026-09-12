import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import { workflowRuns, workflows } from "../../../src/db/schema";
import {
  WORKFLOW_MAX_EXTERNAL_APPS,
  type CreateWorkflowInput,
} from "../../../src/schemas/workflows";
import { createWorkflow } from "../../../src/services/workflows/create";
import { recordWorkflowExternalApps } from "../../../src/services/workflows/record-external-apps";
import { getWorkflowRunContext } from "../../../src/services/workflows/run-context";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * A workflow's declared external apps, filled in by its own runs.
 *
 * Declaring them by hand only ever answered the question BEFORE the first run.
 * After that the runs know: `resolveConnection` returns the exact account each
 * action opened, and folding those ids back onto the workflow is what turns a
 * field somebody has to maintain into a fact nobody has to remember.
 *
 * Integration because every assertion here is about a row as it ends up in
 * Postgres — the append under a row lock, the ceiling the request schema also
 * enforces, and above all the reachability rule that keeps observation from
 * writing a list `validateWorkflowExternalApps` would then refuse to save. A
 * double would answer whatever the test told it and prove none of that.
 */

let fx: WorkspaceFixture;
let owner: string;
let teammate: string;

const playbook = {
  goal: "do the thing",
  tasks: [{ key: "t1", title: "Task", description: "", instructions: "do it" }],
};

const draft = (over: Partial<CreateWorkflowInput>): CreateWorkflowInput => ({
  name: "W",
  description: "",
  playbook,
  triggerType: "manual",
  triggerConfig: {},
  autonomy: "approval_required",
  limits: {},
  ...over,
});

/**
 * A workflow plus the run + conversation an exec context would carry.
 * `scope: "team"` leaves `userId` unset — the run then acts as the team bot,
 * which is what makes a personal connection unreachable to it.
 */
const runningWorkflow = async (
  scope: "team" | "private",
  over: Partial<CreateWorkflowInput> = {},
): Promise<{ workflowId: string; conversationId: string }> => {
  const workflow = await createWorkflow({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    createdByUserId: owner,
    input: draft(scope === "private" ? { ...over, userId: owner } : over),
  });
  // The conversation is the only thing the sandbox JWT carries back, so it is
  // the link under test. `actingUserId` is null for a team run here: the bot
  // user is `getTeamBotUserId`'s business and nothing under test reads it.
  const actingUserId = scope === "private" ? owner : null;
  const conversation = await fx.createConversation({ agentType: "workflow" });
  await db.insert(workflowRuns).values({
    workflowId: workflow.id,
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    actingUserId,
    status: "running",
    triggerType: "manual",
    conversationId: conversation.id,
  });
  return { workflowId: workflow.id, conversationId: conversation.id };
};

const declaredOn = async (workflowId: string): Promise<string[]> => {
  const [row] = await db
    .select({ ids: workflows.externalAppConnectionIds })
    .from(workflows)
    .where(eq(workflows.id, workflowId));
  if (!row) throw new Error("workflow vanished");
  return row.ids;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [owner, teammate] = fx.userIds;
});

afterAll(async () => {
  await fx.cleanup();
});

describe("finding the run behind a conversation", () => {
  test("a run's conversation resolves to its workflow, owner and declared apps", async () => {
    const conn = await fx.createConnection({ createdByUserId: owner });
    const { workflowId, conversationId } = await runningWorkflow("team", {
      autonomy: "read_only",
      externalAppConnectionIds: [conn.id],
    });

    const run = await getWorkflowRunContext(conversationId);
    expect(run).not.toBeNull();
    expect(run?.workflowId).toBe(workflowId);
    expect(run?.ownerUserId).toBeNull();
    expect(run?.autonomy).toBe("read_only");
    expect(run?.externalAppConnectionIds).toEqual([conn.id]);
  });

  test("a plain chat conversation is not a run", async () => {
    const conversation = await fx.createConversation({});
    expect(await getWorkflowRunContext(conversation.id)).toBeNull();
  });
});

describe("recording what a run opened", () => {
  test("a team-shared connection lands on the workflow", async () => {
    const conn = await fx.createConnection({ createdByUserId: owner });
    const { workflowId, conversationId } = await runningWorkflow("team");

    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await recordWorkflowExternalApps(run, [{ id: conn.id, userId: null }]);

    expect(await declaredOn(workflowId)).toEqual([conn.id]);
  });

  test("recording the same app twice leaves one entry", async () => {
    const conn = await fx.createConnection({ createdByUserId: owner });
    const { workflowId, conversationId } = await runningWorkflow("team");
    const observed = [{ id: conn.id, userId: null }];

    const first = await getWorkflowRunContext(conversationId);
    if (!first) throw new Error("expected a run");
    await recordWorkflowExternalApps(first, observed);
    // A second dispatch re-reads the context, so it already sees the id — and
    // a third that somehow didn't must still not double it.
    const second = await getWorkflowRunContext(conversationId);
    if (!second) throw new Error("expected a run");
    await recordWorkflowExternalApps(second, observed);
    await recordWorkflowExternalApps(first, observed);

    expect(await declaredOn(workflowId)).toEqual([conn.id]);
  });

  test("what the author declared keeps its place; observations follow", async () => {
    const declared = await fx.createConnection({ createdByUserId: owner });
    const opened = await fx.createConnection({ createdByUserId: owner });
    const { workflowId, conversationId } = await runningWorkflow("team", {
      externalAppConnectionIds: [declared.id],
    });

    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await recordWorkflowExternalApps(run, [
      { id: declared.id, userId: null },
      { id: opened.id, userId: null },
    ]);

    expect(await declaredOn(workflowId)).toEqual([declared.id, opened.id]);
  });

  test("concurrent dispatches both land — neither overwrites the other", async () => {
    const a = await fx.createConnection({ createdByUserId: owner });
    const b = await fx.createConnection({ createdByUserId: owner });
    const { workflowId, conversationId } = await runningWorkflow("team");

    // Both read the SAME empty list, exactly as two ops of one plan do. Without
    // the row lock the second write would carry only its own id.
    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await Promise.all([
      recordWorkflowExternalApps(run, [{ id: a.id, userId: null }]),
      recordWorkflowExternalApps(run, [{ id: b.id, userId: null }]),
    ]);

    expect([...(await declaredOn(workflowId))].sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  test("the list stops growing at the ceiling the schema enforces", async () => {
    const connections = await Promise.all(
      Array.from({ length: WORKFLOW_MAX_EXTERNAL_APPS + 2 }, () =>
        fx.createConnection({ createdByUserId: owner }),
      ),
    );
    const { workflowId, conversationId } = await runningWorkflow("team");

    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await recordWorkflowExternalApps(
      run,
      connections.map((c) => ({ id: c.id, userId: null })),
    );

    const stored = await declaredOn(workflowId);
    expect(stored).toHaveLength(WORKFLOW_MAX_EXTERNAL_APPS);
    expect(stored).toEqual(
      connections.slice(0, WORKFLOW_MAX_EXTERNAL_APPS).map((c) => c.id),
    );
  });
});

describe("what a run may record is bounded by the workflow's own reach", () => {
  test("a private workflow records its owner's personal connection", async () => {
    const personal = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
    });
    const { workflowId, conversationId } = await runningWorkflow("private");

    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await recordWorkflowExternalApps(run, [{ id: personal.id, userId: owner }]);

    expect(await declaredOn(workflowId)).toEqual([personal.id]);
  });

  test("a team workflow never records a personal connection", async () => {
    // The run acts as the team bot, so this could only arrive from a connection
    // personal to the bot itself. Writing it would leave the workflow in a
    // state `validateWorkflowExternalApps` refuses — unsaveable from the UI.
    const personal = await fx.createConnection({
      userId: teammate,
      createdByUserId: teammate,
    });
    const shared = await fx.createConnection({ createdByUserId: owner });
    const { workflowId, conversationId } = await runningWorkflow("team");

    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await recordWorkflowExternalApps(run, [
      { id: personal.id, userId: teammate },
      { id: shared.id, userId: null },
    ]);

    expect(await declaredOn(workflowId)).toEqual([shared.id]);
  });

  test("a private workflow never records someone else's personal connection", async () => {
    const theirs = await fx.createConnection({
      userId: teammate,
      createdByUserId: teammate,
    });
    const { workflowId, conversationId } = await runningWorkflow("private");

    const run = await getWorkflowRunContext(conversationId);
    if (!run) throw new Error("expected a run");
    await recordWorkflowExternalApps(run, [
      { id: theirs.id, userId: teammate },
    ]);

    expect(await declaredOn(workflowId)).toEqual([]);
  });
});
