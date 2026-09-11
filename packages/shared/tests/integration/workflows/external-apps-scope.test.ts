import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CreateWorkflowInput } from "../../../src/schemas/workflows";
import { createWorkflow } from "../../../src/services/workflows/create";
import { updateWorkflow } from "../../../src/services/workflows/update";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * The rule that binds a workflow's declared external apps to its scope.
 *
 * It is not a policy layered on top — it is what the runtime already does. A
 * run acts as `workflow.userId ?? the team bot`, and `resolveConnection` only
 * ever returns a connection that is team-shared or scoped to that identity. So
 * a team workflow declaring a personal connection is a promise the run cannot
 * keep, and the failure lands inside a cron run nobody is watching. These
 * assertions pin the refusal to the moment the author can still act on it.
 *
 * Integration because the decision reads the connection rows as they exist —
 * `user_id` on each declared id, filtered by the workflow's team. A double
 * would answer whatever the test said and prove nothing about the one query
 * that keeps another member's personal mailbox from being named here.
 */

let fx: WorkspaceFixture;
let owner: string;
let teammate: string;

const playbook = {
  goal: "do the thing",
  tasks: [{ key: "t1", title: "Task", description: "", instructions: "do it" }],
};

/** `CreateWorkflowInput` is the schema's OUTPUT type, so its defaults are
 *  required of a caller; only the fields under test vary here. */
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

const messageOf = (err: Error): string => {
  try {
    const parsed: unknown = JSON.parse(err.message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Not an envelope — the raw message is the message.
  }
  return err.message;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [owner, teammate] = fx.userIds;
});

afterAll(async () => {
  await fx.cleanup();
});

describe("declaring apps on a team workflow", () => {
  test("a team-shared connection is accepted", async () => {
    const conn = await fx.createConnection({ createdByUserId: owner });
    const workflow = await createWorkflow({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      createdByUserId: owner,
      input: draft({ externalAppConnectionIds: [conn.id] }),
    });
    expect(workflow.externalAppConnectionIds).toEqual([conn.id]);
  });

  test("a personal connection is refused, with the way out in the message", async () => {
    const personal = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
      displayName: "My mailbox",
    });
    const err = await rejection(
      createWorkflow({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        createdByUserId: owner,
        input: draft({ externalAppConnectionIds: [personal.id] }),
      }),
    );
    expect(messageOf(err)).toContain("My mailbox");
    expect(messageOf(err)).toContain("private");
  });
});

describe("declaring apps on a private workflow", () => {
  test("the owner's own personal connection is accepted", async () => {
    const personal = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
    });
    const workflow = await createWorkflow({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      createdByUserId: owner,
      input: draft({ userId: owner, externalAppConnectionIds: [personal.id] }),
    });
    expect(workflow.externalAppConnectionIds).toEqual([personal.id]);
  });

  test("someone else's personal connection is not even nameable", async () => {
    const theirs = await fx.createConnection({
      userId: teammate,
      createdByUserId: teammate,
    });
    const err = await rejection(
      createWorkflow({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        createdByUserId: owner,
        input: draft({ userId: owner, externalAppConnectionIds: [theirs.id] }),
      }),
    );
    expect(messageOf(err)).toContain("Unknown external-app connection");
    // The name never leaks: an author who cannot use a connection does not get
    // told what a teammate called it.
    expect(messageOf(err)).not.toContain("Integration app");
  });

  test("an admin cannot lend their OWN app to a teammate's workflow", async () => {
    // The one case where the writer and the workflow's identity differ. The
    // admin can name this connection — it is theirs — but the run acts as the
    // teammate, who could not resolve it. Refused on the workflow's identity,
    // not on the author's, which is the distinction the two checks exist for.
    const adminsOwn = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
      displayName: "Admin's own mailbox",
    });
    const theirWorkflow = await createWorkflow({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      createdByUserId: teammate,
      input: draft({ userId: teammate }),
    });
    const err = await rejection(
      updateWorkflow({
        id: theirWorkflow.id,
        teamId: fx.teamId,
        input: { externalAppConnectionIds: [adminsOwn.id] },
        requester: { userId: owner, isAdmin: true },
      }),
    );
    expect(messageOf(err)).toContain("Admin's own mailbox");
    expect(messageOf(err)).toContain("personal to someone else");
  });
});

describe("re-scoping a workflow that declares apps", () => {
  const createPrivateWith = async (connectionId: string) =>
    createWorkflow({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      createdByUserId: owner,
      input: draft({ userId: owner, externalAppConnectionIds: [connectionId] }),
    });

  test("going team-shared is refused while a personal app is declared", async () => {
    // The patch carries only the scope — the stored list is what makes it
    // invalid, so validating solely what the patch contains would let it
    // through and break the workflow silently on its next run.
    const personal = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
      displayName: "Personal CRM",
    });
    const workflow = await createPrivateWith(personal.id);
    const err = await rejection(
      updateWorkflow({
        id: workflow.id,
        teamId: fx.teamId,
        input: { userId: null },
        requester: { userId: owner, isAdmin: false },
      }),
    );
    expect(messageOf(err)).toContain("Personal CRM");
  });

  test("going team-shared is fine once only team apps are declared", async () => {
    const personal = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
    });
    const shared = await fx.createConnection({ createdByUserId: owner });
    const workflow = await createPrivateWith(personal.id);
    const updated = await updateWorkflow({
      id: workflow.id,
      teamId: fx.teamId,
      input: { userId: null, externalAppConnectionIds: [shared.id] },
      requester: { userId: owner, isAdmin: false },
    });
    expect(updated?.userId).toBeNull();
    expect(updated?.externalAppConnectionIds).toEqual([shared.id]);
  });

  test("clearing the list is a normal update", async () => {
    const personal = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
    });
    const workflow = await createPrivateWith(personal.id);
    const updated = await updateWorkflow({
      id: workflow.id,
      teamId: fx.teamId,
      input: { externalAppConnectionIds: [] },
      requester: { userId: owner, isAdmin: false },
    });
    expect(updated?.externalAppConnectionIds).toEqual([]);
  });
});
