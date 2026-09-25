import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * A private workflow runs AS its owner. Once that person has left the team it
 * must stop: no new run, and the workflow paused with a reason the team can
 * read. Two workflows below differ in their owner alone — only the one owned
 * by the person who left is touched.
 */

// Process boundaries a pause crosses: the schedule API and the vector refresh
// the AI service performs. Neither is what these tests are about.
await mockModule("../../../src/lib/trigger-client", {
  deleteWorkflowSchedule: () => Promise.resolve(),
  cancelWorkflowTriggerRun: () => Promise.resolve(),
});
await mockModule("../../../src/lib/ai-service", {
  callAiService: () => Promise.resolve({ success: true }),
});

const { default: db } = await import("../../../src/db");
const { teamMember, workflows } = await import("../../../src/db/schema");
const {
  assertWorkflowOwnerPresent,
  OWNER_GONE_PAUSE_REASON,
  pauseWorkflowsOfDepartedMember,
} = await import("../../../src/services/workflows/owner-presence");
const { createWorkspaceFixture } = await import("../../lib/db-fixtures");

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
type Playbook = typeof workflows.$inferInsert.playbook;

const PLAYBOOK: Playbook = {
  goal: "stand in for a scheduled job",
  tasks: [
    { key: "t", title: "Nothing", description: "", instructions: "Nothing." },
  ],
};

let fx: Fixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const activeWorkflow = async (ownerId: string | null) => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: ownerId,
      name: "Scheduled job",
      triggerType: "manual",
      playbook: PLAYBOOK,
      status: "active",
    })
    .returning();
  if (!row) throw new Error("fixture: no workflow");
  return row;
};

const stateOf = async (id: string) =>
  db.query.workflows.findFirst({
    columns: { status: true, pausedReason: true },
    where: { id },
  });

const leaveTeam = async (userId: string): Promise<void> => {
  await db
    .delete(teamMember)
    .where(
      and(eq(teamMember.teamId, fx.teamId), eq(teamMember.userId, userId)),
    );
};

describe("a private workflow stops when its owner leaves", () => {
  test("a run is refused and the workflow paused with the reason", async () => {
    // A throwaway owner, so leaving does not disturb the other tests.
    const leaver = fx.userIds[1];
    const workflow = await activeWorkflow(leaver);
    await assertWorkflowOwnerPresent(workflow);

    await leaveTeam(leaver);

    const error = await rejection(assertWorkflowOwnerPresent(workflow));
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(409);
    expect(await stateOf(workflow.id)).toEqual({
      status: "paused",
      pausedReason: OWNER_GONE_PAUSE_REASON,
    });
  });

  test("the departure pauses only the leaver's private workflows", async () => {
    const [stayer, leaver] = fx.userIds;
    const theirs = await activeWorkflow(leaver);
    const mine = await activeWorkflow(stayer);
    const shared = await activeWorkflow(null);

    const paused = await pauseWorkflowsOfDepartedMember({
      userId: leaver,
      teamIds: [fx.teamId],
    });

    expect(paused).toBe(1);
    expect((await stateOf(theirs.id))?.status).toBe("paused");
    expect((await stateOf(mine.id))?.status).toBe("active");
    expect((await stateOf(shared.id))?.status).toBe("active");
  });
});
