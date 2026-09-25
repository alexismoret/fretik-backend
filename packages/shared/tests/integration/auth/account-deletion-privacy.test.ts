import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import { user, workflows } from "../../../src/db/schema";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * On pages and workflows, `user_id` NULL means "shared with the team". The
 * foreign key used to SET NULL when the owner's account was deleted, which
 * published every private page and workflow of that person to their whole
 * team. The two rows of each table below differ in their owner alone: the
 * departed person's private one leaves with the account, the team's stays.
 */

const PLAYBOOK: WorkflowPlaybook = {
  goal: "outlive or not its owner",
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

const createWorkflow = async (ownerId: string | null): Promise<string> => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: ownerId,
      name: "Weekly digest",
      triggerType: "manual",
      playbook: PLAYBOOK,
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("fixture: no workflow");
  return row.id;
};

const pageExists = async (id: string): Promise<boolean> =>
  (await db.query.pages.findFirst({ columns: { id: true }, where: { id } })) !==
  undefined;

const workflowExists = async (id: string): Promise<boolean> =>
  (await db.query.workflows.findFirst({
    columns: { id: true },
    where: { id },
  })) !== undefined;

describe("deleting an account never shares its private work", () => {
  test("private pages and workflows leave with their owner", async () => {
    const departed = fx.userIds[1];
    const privatePage = await fx.createPage({ userId: departed });
    const sharedPage = await fx.createPage({ userId: null });
    const privateWorkflow = await createWorkflow(departed);
    const sharedWorkflow = await createWorkflow(null);

    await db.delete(user).where(eq(user.id, departed));

    expect(await pageExists(privatePage.id)).toBe(false);
    expect(await workflowExists(privateWorkflow)).toBe(false);
    expect(await pageExists(sharedPage.id)).toBe(true);
    expect(await workflowExists(sharedWorkflow)).toBe(true);
  });
});
