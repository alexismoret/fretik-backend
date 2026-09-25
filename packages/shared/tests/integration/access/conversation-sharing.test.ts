import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../src/db";
import {
  accessAuditLog,
  accessGrants,
  accessRequests,
  aiConversationMembers,
  teamMember,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Sharing a chat from the share dialog. Taking part is a SEAT
 * (`ai_conversation_members`) and reading is a grant; the grant store moves a
 * person between the two, so the dialog reads and writes one list. Taking
 * part is only for the people of the chat's team: anyone else the chat reaches
 * reads it, and cannot even ask for more.
 *
 * The fixture's owner (an organization owner) starts each chat and owns it;
 * the member is a teammate. Someone outside the team is added where a case
 * needs one. The only double is the email transport: requests and their
 * answers write to people.
 */

await mockModule("../../src/lib/email", {
  sendEmail: () => Promise.resolve(),
});

const { resolveAccess } = await import("../../../src/authz/access");
const { bootstrapTeamWithBotUser } =
  await import("../../../src/services/auth/bot-user");
const { requestAccess } =
  await import("../../../src/services/access/requests/request-access");
const { decideAccessRequest } =
  await import("../../../src/services/access/requests/decide-request");
const { changeGrantLevel } =
  await import("../../../src/services/access/sharing/change-grant-level");
const { describeResourceAccess } =
  await import("../../../src/services/access/sharing/describe");
const { listSharedWithMe } =
  await import("../../../src/services/access/sharing/list-shared-with-me");
const { revokeGrant } =
  await import("../../../src/services/access/sharing/revoke-grant");
const { setGeneralAccess } =
  await import("../../../src/services/access/sharing/set-general-access");
const { shareResource } =
  await import("../../../src/services/access/sharing/share");
const { assertConversationAccess } =
  await import("../../../src/services/ai/assert-conversation-access");
const { chatAudience } = await import("../../../src/services/ai/audience");
const { getReadableConversation, requireConversation } =
  await import("../../../src/services/ai/get");
const { addConversationMembers } =
  await import("../../../src/services/ai/members/add");
const { applyMentions } =
  await import("../../../src/services/ai/members/mention");
const { removeConversationMember } =
  await import("../../../src/services/ai/members/remove");

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  // The settings row every team gets on creation: listing a team's people
  // leaves out its agent, whose account that row names.
  await bootstrapTeamWithBotUser({
    teamId: fx.teamId,
    organizationId: fx.organizationId,
  });
});

afterEach(async () => {
  await fx.cleanup();
});

const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

/** A private chat of the team, owned by the fixture's owner. */
const createChat = async (): Promise<string> => {
  const chat = await fx.createConversation({ userId: ownerId });
  await db
    .insert(aiConversationMembers)
    .values({ conversationId: chat.id, userId: ownerId, role: "owner" });
  return chat.id;
};

const seatsOf = async (chatId: string) =>
  db
    .select({
      userId: aiConversationMembers.userId,
      role: aiConversationMembers.role,
    })
    .from(aiConversationMembers)
    .where(eq(aiConversationMembers.conversationId, chatId));

const grantsOf = async (chatId: string) =>
  db
    .select({
      principalType: accessGrants.principalType,
      principalId: accessGrants.principalId,
      level: accessGrants.level,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, "conversation"),
        eq(accessGrants.resourceId, chatId),
      ),
    );

const levelOf = async (chatId: string, userId: string) =>
  (await resolveAccess(await fx.principalOf(userId), "conversation", chatId))
    ?.level ?? null;

const share = async (
  chatId: string,
  principals: { type: "user" | "team" | "organization"; id: string }[],
  level: "view" | "use",
) =>
  shareResource({
    principal: await fx.principalOf(ownerId),
    type: "conversation",
    id: chatId,
    principals,
    level,
  });

const person = (id: string) => ({ type: "user" as const, id });

describe("sharing a chat", () => {
  test("taking part is a seat, reading a grant, and a new level moves the person", async () => {
    const chat = await createChat();
    const owner = await fx.principalOf(ownerId);

    await share(chat, [person(memberId)], "use");
    expect(await seatsOf(chat)).toContainEqual({
      userId: memberId,
      role: "member",
    });
    expect(await grantsOf(chat)).toEqual([]);
    expect(await levelOf(chat, memberId)).toBe("use");

    await changeGrantLevel({
      principal: owner,
      type: "conversation",
      id: chat,
      holder: person(memberId),
      level: "view",
    });
    expect(await seatsOf(chat)).toEqual([{ userId: ownerId, role: "owner" }]);
    expect(await grantsOf(chat)).toEqual([
      { principalType: "user", principalId: memberId, level: "view" },
    ]);
    expect(await levelOf(chat, memberId)).toBe("view");

    const model = await describeResourceAccess({
      principal: owner,
      type: "conversation",
      id: chat,
    });
    expect(
      model.holders.map((holder) => [holder.principalId, holder.level]),
    ).toEqual([[memberId, "view"]]);
    expect(model.owner?.userId).toBe(ownerId);
    expect(model.offeredLevels).toEqual(["view", "use"]);
    expect(model.groupLevels).toEqual(["view"]);
    expect(model.ceilings).toEqual({
      team: "full",
      outsider: "view",
      guest: "view",
      insiders: null,
    });
    expect(model.general.inheritedLevel).toBe("view");

    await revokeGrant({
      principal: owner,
      type: "conversation",
      id: chat,
      holder: person(memberId),
    });
    expect(await grantsOf(chat)).toEqual([]);
    expect(await levelOf(chat, memberId)).toBeNull();
  });

  test("the owner is never a holder to change or remove", async () => {
    const chat = await createChat();
    const owner = await fx.principalOf(ownerId);

    expect(
      await refusal(
        changeGrantLevel({
          principal: owner,
          type: "conversation",
          id: chat,
          holder: person(ownerId),
          level: "view",
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(await seatsOf(chat)).toEqual([{ userId: ownerId, role: "owner" }]);
    expect(await grantsOf(chat)).toEqual([]);
  });

  test("a reader opens it without a seat: its level, and no state of their own", async () => {
    const chat = await createChat();
    await share(chat, [person(memberId)], "view");
    const reader = await fx.principalOf(memberId);

    const resource = await assertConversationAccess({
      conversationId: chat,
      principal: reader,
      level: "view",
    });
    const seen = await getReadableConversation({ resource, userId: memberId });
    expect(seen).toMatchObject({
      id: chat,
      level: "view",
      role: null,
      unread: false,
      actionRequired: false,
      pinned: false,
    });
    expect(seen?.members.map((member) => member.userId)).toEqual([ownerId]);

    const refused = await rejection(
      requireConversation({
        principal: reader,
        conversationId: chat,
        level: "use",
      }),
    );
    expect(refused).toBeInstanceOf(HTTPException);
    expect(parseApiError((refused as HTTPException).message)).toMatchObject({
      code: "ACCESS_DENIED",
      access: { reason: "INSUFFICIENT_LEVEL", requestable: true },
    });

    // Found where they find what others share with them.
    const shared = await listSharedWithMe(reader);
    expect(shared.items.map((item) => item.resource.id)).toContain(chat);
  });

  test("a malformed or unknown id answers like a chat that does not exist", async () => {
    const principal = await fx.principalOf(ownerId);
    for (const conversationId of ["not-a-uuid", crypto.randomUUID()]) {
      expect(
        await refusal(
          requireConversation({ principal, conversationId, level: "view" }),
        ),
      ).toEqual({ status: 404, code: "NOT_FOUND" });
    }
  });

  test("the owner reads it as its owner", async () => {
    const chat = await createChat();
    const { conversation } = await requireConversation({
      principal: await fx.principalOf(ownerId),
      conversationId: chat,
      level: "use",
    });
    expect(conversation).toMatchObject({ level: "full", role: "owner" });
  });
});

describe("taking part is for the chat's team", () => {
  test("someone outside it is given the chat to read, never a seat", async () => {
    const chat = await createChat();
    const outsider = await fx.addPerson({ inTeam: false });

    expect(await refusal(share(chat, [person(outsider)], "use"))).toEqual({
      status: 400,
      code: "PARTICIPANT_OUTSIDE_TEAM",
    });
    expect(await seatsOf(chat)).toEqual([{ userId: ownerId, role: "owner" }]);

    await share(chat, [person(outsider)], "view");
    expect(await levelOf(chat, outsider)).toBe("view");
    // Asking to take part is refused before anyone is asked.
    const denied = await rejection(
      requestAccess({
        principal: await fx.principalOf(outsider),
        type: "conversation",
        id: chat,
        level: "use",
      }),
    );
    expect(parseApiError((denied as HTTPException).message)).toMatchObject({
      code: "ACCESS_DENIED",
      access: { reason: "LEVEL_CAP", requestable: false },
    });
  });

  test("a group reads it; taking part is a person's", async () => {
    const chat = await createChat();

    expect(
      await refusal(share(chat, [{ type: "team", id: fx.teamId }], "use")),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });

    await share(
      chat,
      [{ type: "organization", id: fx.organizationId }],
      "view",
    );
    expect(await levelOf(chat, memberId)).toBe("view");
  });

  test("someone who leaves the team keeps reading with their seat, and nothing more", async () => {
    const chat = await createChat();
    await share(chat, [person(memberId)], "use");

    await db
      .delete(teamMember)
      .where(
        and(eq(teamMember.teamId, fx.teamId), eq(teamMember.userId, memberId)),
      );

    expect(await levelOf(chat, memberId)).toBe("view");
    const refused = await rejection(
      requireConversation({
        principal: await fx.principalOf(memberId),
        conversationId: chat,
        level: "use",
      }),
    );
    expect(parseApiError((refused as HTTPException).message)).toMatchObject({
      code: "ACCESS_DENIED",
      access: { reason: "LEVEL_CAP", requestable: false },
    });
  });
});

describe("general access", () => {
  test("opened to its team, a chat is read there; taking part stays a seat", async () => {
    const chat = await createChat();
    const owner = await fx.principalOf(ownerId);
    expect(await levelOf(chat, memberId)).toBeNull();

    await setGeneralAccess({
      principal: owner,
      type: "conversation",
      id: chat,
      restricted: false,
    });
    expect(await levelOf(chat, memberId)).toBe("view");
    const journal = await db
      .select({ metadata: accessAuditLog.metadata })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "restriction.changed"),
        ),
      );
    expect(journal).toHaveLength(1);

    await setGeneralAccess({
      principal: owner,
      type: "conversation",
      id: chat,
      restricted: true,
    });
    expect(await levelOf(chat, memberId)).toBeNull();
  });

  test("a teammate who reads it asks to take part, and the answer seats them", async () => {
    const chat = await createChat();
    const owner = await fx.principalOf(ownerId);
    await setGeneralAccess({
      principal: owner,
      type: "conversation",
      id: chat,
      restricted: false,
    });

    const request = await requestAccess({
      principal: await fx.principalOf(memberId),
      type: "conversation",
      id: chat,
      level: "use",
    });
    await decideAccessRequest({
      principal: owner,
      requestId: request.id,
      decision: "approve",
    });

    expect(await seatsOf(chat)).toContainEqual({
      userId: memberId,
      role: "member",
    });
    expect(await levelOf(chat, memberId)).toBe("use");
  });
});

describe("participants bring colleagues in", () => {
  test("from the members list: teammates only, journaled, answering their request", async () => {
    const chat = await createChat();
    const colleague = await fx.addPerson();
    const outsider = await fx.addPerson({ inTeam: false });
    await share(chat, [person(memberId)], "use");
    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "conversation",
      id: chat,
      restricted: false,
    });
    const request = await requestAccess({
      principal: await fx.principalOf(colleague),
      type: "conversation",
      id: chat,
      level: "use",
    });

    const participant = await fx.principalOf(memberId);
    const roster = await addConversationMembers({
      principal: participant,
      resource: await assertConversationAccess({
        conversationId: chat,
        principal: participant,
        level: "use",
      }),
      userIds: [colleague, outsider],
    });

    expect(roster.map((member) => member.userId).sort()).toEqual(
      [ownerId, memberId, colleague].sort(),
    );
    const created = await db
      .select({
        actorUserId: accessAuditLog.actorUserId,
        principalId: accessAuditLog.principalId,
      })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "grant.created"),
          eq(accessAuditLog.principalId, colleague),
        ),
      );
    expect(created).toEqual([
      { actorUserId: memberId, principalId: colleague },
    ]);
    const [answered] = await db
      .select({ status: accessRequests.status })
      .from(accessRequests)
      .where(eq(accessRequests.id, request.id));
    expect(answered?.status).toBe("approved");
  });

  test("an @mention seats the teammate mentioned", async () => {
    const chat = await createChat();
    const owner = await fx.principalOf(ownerId);

    const mentioned = await applyMentions({
      principal: owner,
      resource: await assertConversationAccess({
        conversationId: chat,
        principal: owner,
        level: "use",
      }),
      mentionedUserIds: [memberId],
    });

    expect(mentioned.map((member) => member.userId)).toEqual([memberId]);
    expect(await levelOf(chat, memberId)).toBe("use");
  });

  test("taking someone out is journaled like any access taken away", async () => {
    const chat = await createChat();
    await share(chat, [person(memberId)], "use");

    await removeConversationMember({
      conversationId: chat,
      teamId: fx.teamId,
      principal: await fx.principalOf(ownerId),
      targetUserId: memberId,
    });

    expect(await levelOf(chat, memberId)).toBeNull();
    const removed = await db
      .select({ principalId: accessAuditLog.principalId })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "grant.removed"),
        ),
      );
    expect(removed).toEqual([{ principalId: memberId }]);
  });
});

describe("who reads what the assistant writes", () => {
  test("nobody but the writer, participants, then readers", async () => {
    const chat = await createChat();
    const owner = await fx.principalOf(ownerId);
    const audience = async () =>
      chatAudience(
        (
          await assertConversationAccess({
            conversationId: chat,
            principal: await fx.principalOf(ownerId),
            level: "view",
          })
        ).node,
        ownerId,
      );

    expect(await audience()).toEqual({ others: false, readers: false });

    await share(chat, [person(memberId)], "use");
    expect(await audience()).toEqual({ others: true, readers: false });

    await changeGrantLevel({
      principal: owner,
      type: "conversation",
      id: chat,
      holder: person(memberId),
      level: "view",
    });
    expect(await audience()).toEqual({ others: true, readers: true });

    await revokeGrant({
      principal: owner,
      type: "conversation",
      id: chat,
      holder: person(memberId),
    });
    expect(await audience()).toEqual({ others: false, readers: false });

    await setGeneralAccess({
      principal: owner,
      type: "conversation",
      id: chat,
      restricted: false,
    });
    expect(await audience()).toEqual({ others: true, readers: true });
  });
});
