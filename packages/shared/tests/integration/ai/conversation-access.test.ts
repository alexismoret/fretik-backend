import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import db from "../../../src/db";
import {
  aiConversationMembers,
  workflowRuns,
  workflows,
} from "../../../src/db/schema";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import { assertConversationAccess } from "../../../src/services/ai/assert-conversation-access";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * Who may open a conversation — the gate in front of its attachments and of
 * the files its agent produced.
 *
 * The file routes used to check the TEAM only, so any teammate holding the id
 * of a solo chat could list, download or delete its attachments. Each case
 * below pairs two callers of the same team who differ in the one thing the
 * rule is about: taking part in the chat, or seeing the workflow.
 *
 * The fixture's first user is the organization owner, the second a member.
 */

const PLAYBOOK: WorkflowPlaybook = {
  goal: "hold a conversation for the access tests",
  tasks: [
    {
      key: "only-task",
      title: "Nothing",
      description: "",
      instructions: "Nothing to do.",
    },
  ],
};

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const caller = (userId: string) => ({
  teamId: fx.teamId,
  organizationId: fx.organizationId,
  userId,
});

const expectAbsent = async (promise: Promise<unknown>): Promise<void> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HTTPException);
  expect((error as HTTPException).status).toBe(404);
};

/** A workflow run and its conversation; `ownerId` makes the workflow private. */
const createRunConversation = async (ownerId: string | null) => {
  const conversation = await fx.createConversation({
    agentType: "workflow",
    userId: ownerId ?? fx.userIds[0],
  });
  const [workflow] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: ownerId,
      name: "Access subject",
      triggerType: "manual",
      playbook: PLAYBOOK,
      createdByUserId: fx.userIds[0],
    })
    .returning({ id: workflows.id });
  if (!workflow) throw new Error("fixture: no workflow");
  await db.insert(workflowRuns).values({
    workflowId: workflow.id,
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    triggerType: "manual",
    conversationId: conversation.id,
  });
  return conversation.id;
};

describe("a chat belongs to its participants", () => {
  test("a teammate who is not in the chat cannot open it", async () => {
    const [author, teammate] = fx.userIds;
    const chat = await fx.createConversation({ userId: author });
    await db
      .insert(aiConversationMembers)
      .values({ conversationId: chat.id, userId: author, role: "owner" });

    await assertConversationAccess({
      conversationId: chat.id,
      ...caller(author),
    });
    await expectAbsent(
      assertConversationAccess({
        conversationId: chat.id,
        ...caller(teammate),
      }),
    );
  });

  test("a chat of another team is absent even to a participant", async () => {
    const [author] = fx.userIds;
    const otherTeam = await fx.createTeam();
    const chat = await fx.createConversation({
      userId: author,
      teamId: otherTeam.id,
    });
    await db
      .insert(aiConversationMembers)
      .values({ conversationId: chat.id, userId: author, role: "owner" });

    await expectAbsent(
      assertConversationAccess({
        conversationId: chat.id,
        ...caller(author),
      }),
    );
  });
});

describe("a workflow run belongs to whoever may see the workflow", () => {
  test("a team-shared workflow's run is open to the team", async () => {
    const conversationId = await createRunConversation(null);

    await assertConversationAccess({
      conversationId,
      ...caller(fx.userIds[1]),
    });
  });

  test("a private workflow's run is its owner's, and an admin's", async () => {
    const [owner, member] = fx.userIds;
    // Private to the MEMBER: the owner of the organization is the admin here.
    const conversationId = await createRunConversation(member);

    await assertConversationAccess({ conversationId, ...caller(member) });
    await assertConversationAccess({ conversationId, ...caller(owner) });

    const privateToOwner = await createRunConversation(owner);
    await expectAbsent(
      assertConversationAccess({
        conversationId: privateToOwner,
        ...caller(member),
      }),
    );
  });
});
