import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { domainEvents, workflows } from "../../../src/db/schema";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import { getDashboardActivity } from "../../../src/services/dashboard/get-activity";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The home feed reads the team's journal, where every workflow run lands —
 * including runs of workflows private to one member. Two workflows of the same
 * team below differ only in their owner; the reader sees the run of the
 * shared one and of their own, never the colleague's private one.
 */

const PLAYBOOK: WorkflowPlaybook = {
  goal: "appear in the activity feed",
  tasks: [
    { key: "t", title: "Nothing", description: "", instructions: "Nothing." },
  ],
};

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const workflowWithRun = async (
  name: string,
  ownerId: string | null,
): Promise<void> => {
  const [workflow] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: ownerId,
      name,
      triggerType: "manual",
      playbook: PLAYBOOK,
    })
    .returning({ id: workflows.id });
  if (!workflow) throw new Error("fixture: no workflow");
  await db.insert(domainEvents).values({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    type: "workflow.run.completed",
    actorType: "workflow",
    payload: { workflowId: workflow.id, status: "succeeded" },
  });
};

describe("the activity feed respects workflow privacy", () => {
  test("a colleague's private workflow does not appear", async () => {
    const [reader, colleague] = fx.userIds;
    await workflowWithRun("Shared report", null);
    await workflowWithRun("My own digest", reader);
    await workflowWithRun("Colleague's private job", colleague);

    const { items } = await getDashboardActivity({
      teamId: fx.teamId,
      userId: reader,
    });

    expect(items.map((item) => item.title).sort()).toEqual([
      "My own digest",
      "Shared report",
    ]);
  });
});
