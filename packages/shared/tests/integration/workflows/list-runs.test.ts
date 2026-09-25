import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { workflowRuns, workflows } from "../../../src/db/schema";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import { listWorkflowRuns } from "../../../src/services/workflows/list-runs";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * A workflow's run history, with and without the launches its condition
 * filtered out. The history hides them by default, so `filteredCount` is what
 * tells a person they exist: it must count THIS workflow's filtered launches
 * (not a sibling's, not its real runs), whatever the page shows.
 */

const PLAYBOOK: WorkflowPlaybook = {
  goal: "File supplier invoices",
  tasks: [{ key: "t", title: "T", description: "", instructions: "i" }],
};

let ws: WorkspaceFixture;
let workflowId: string;

const createWorkflow = async (name: string): Promise<string> => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      name,
      triggerType: "event",
      playbook: PLAYBOOK,
      status: "active",
      createdByUserId: ws.userIds[0],
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("fixture: workflow");
  return row.id;
};

const run = (
  id: string,
  status: "filtered" | "succeeded",
): typeof workflowRuns.$inferInsert => ({
  workflowId: id,
  organizationId: ws.organizationId,
  teamId: ws.teamId,
  triggerType: "event",
  status,
});

beforeAll(async () => {
  ws = await createWorkspaceFixture();
  workflowId = await createWorkflow("Invoice filing");
  const sibling = await createWorkflow("Contract review");
  await db.insert(workflowRuns).values([
    run(workflowId, "filtered"),
    run(workflowId, "filtered"),
    run(workflowId, "succeeded"),
    // A sibling's filtered launch is not this workflow's.
    run(sibling, "filtered"),
  ]);
});

afterAll(async () => {
  await ws.cleanup();
});

const list = (hideFiltered: boolean) =>
  listWorkflowRuns({
    workflowId,
    teamId: ws.teamId,
    params: { limit: 20, page: 0 },
    hideFiltered,
  });

describe("listWorkflowRuns", () => {
  test("hidden, the filtered launches leave the page and the total, and are still counted", async () => {
    const page = await list(true);
    expect(page.data.map((r) => r.status)).toEqual(["succeeded"]);
    expect(page.count).toBe(1);
    expect(page.filteredCount).toBe(2);
  });

  test("shown, they are on the page and in the total, and counted the same", async () => {
    const page = await list(false);
    expect(page.data).toHaveLength(3);
    expect(page.count).toBe(3);
    expect(page.filteredCount).toBe(2);
  });
});
