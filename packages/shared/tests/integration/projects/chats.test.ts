import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { adapterFor, resolveAccess } from "../../../src/authz/access";
import db from "../../../src/db";
import {
  aiConversationMembers,
  teamMember,
  teamMemberRoles,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import { describeResourceAccess } from "../../../src/services/access/sharing/describe";
import { setGeneralAccess } from "../../../src/services/access/sharing/set-general-access";
import { shareResource } from "../../../src/services/access/sharing/share";
import { createConversation } from "../../../src/services/ai/create";
import { listProjectConversations } from "../../../src/services/ai/list-in-project";
import { takingPartCandidates } from "../../../src/services/ai/members/candidates";
import { bootstrapTeamWithBotUser } from "../../../src/services/auth/bot-user";
import { createProject } from "../../../src/services/projects/create";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * A chat in a project is the project's: taking part in it is for the people
 * who take part in the project, whatever their team, and a chat opened to
 * the project is read by everyone in it.
 *
 * `owner` and `member` are in the team; `viewer` is a team viewer (the open
 * project gives them `view`); `outsider` is in another team and takes part
 * in the project; `stranger` is in that other team and not in the project.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;
let viewerId: string;
let outsiderId: string;
let strangerId: string;
let projectId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  await bootstrapTeamWithBotUser({
    teamId: fx.teamId,
    organizationId: fx.organizationId,
  });
  viewerId = await fx.addPerson();
  const [seat] = await db
    .select({ id: teamMember.id })
    .from(teamMember)
    .where(
      and(eq(teamMember.teamId, fx.teamId), eq(teamMember.userId, viewerId)),
    );
  await db.insert(teamMemberRoles).values({
    teamMemberId: seat!.id,
    teamId: fx.teamId,
    userId: viewerId,
    role: "viewer",
  });
  const otherTeamId = (await fx.createTeam()).id;
  outsiderId = await fx.addPerson({ inTeam: false });
  strangerId = await fx.addPerson({ inTeam: false });
  await db.insert(teamMember).values([
    { userId: outsiderId, teamId: otherTeamId, createdAt: new Date() },
    { userId: strangerId, teamId: otherTeamId, createdAt: new Date() },
  ]);

  projectId = (
    await createProject({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      project: { name: "Launch", description: "", restricted: false },
    })
  ).id;
  await shareResource({
    principal: await fx.principalOf(ownerId),
    type: "project",
    id: projectId,
    principals: [{ type: "user", id: outsiderId }],
    level: "use",
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

const chatOf = async (userId: string, inProject = true) =>
  createConversation({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    projectId: inProject ? projectId : null,
    userId,
    title: "Plan",
  });

const seat = async (by: string, chatId: string, userIds: string[]) =>
  shareResource({
    principal: await fx.principalOf(by),
    type: "conversation",
    id: chatId,
    principals: userIds.map((id) => ({ type: "user" as const, id })),
    level: "use",
  });

const levelOf = async (userId: string, chatId: string) =>
  (await resolveAccess(await fx.principalOf(userId), "conversation", chatId))
    ?.level ?? null;

describe("taking part in a project's chat", () => {
  test("is for the project's participants, whatever their team", async () => {
    const chat = await chatOf(ownerId);
    await seat(ownerId, chat.id, [outsiderId, memberId]);

    expect(await levelOf(outsiderId, chat.id)).toBe("use");
    expect(await levelOf(memberId, chat.id)).toBe("use");
    const seats = await db
      .select({ userId: aiConversationMembers.userId })
      .from(aiConversationMembers)
      .where(eq(aiConversationMembers.conversationId, chat.id));
    expect(seats.map((row) => row.userId).sort()).toEqual(
      [ownerId, outsiderId, memberId].sort(),
    );
  });

  test("not for a viewer of the project, nor someone outside it: they can read it", async () => {
    const chat = await chatOf(ownerId);
    expect(await refusal(seat(ownerId, chat.id, [viewerId]))).toEqual({
      status: 400,
      code: "PARTICIPANT_OUTSIDE_TEAM",
    });
    expect(await refusal(seat(ownerId, chat.id, [strangerId]))).toEqual({
      status: 400,
      code: "PARTICIPANT_OUTSIDE_TEAM",
    });

    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "conversation",
      id: chat.id,
      principals: [{ type: "user", id: strangerId }],
      level: "view",
    });
    expect(await levelOf(strangerId, chat.id)).toBe("view");
  });

  test("a team's chat stays its team's: the project's outsider only reads it", async () => {
    const teamChat = await chatOf(ownerId, false);
    expect(await refusal(seat(ownerId, teamChat.id, [outsiderId]))).toEqual({
      status: 400,
      code: "PARTICIPANT_OUTSIDE_TEAM",
    });
  });

  test("the share dialog names who can take part, and the pickers offer only them", async () => {
    const chat = await chatOf(ownerId);
    const model = await describeResourceAccess({
      principal: await fx.principalOf(ownerId),
      type: "conversation",
      id: chat.id,
    });
    expect(model.ceilings.team).toBe("full");
    expect(model.ceilings.outsider).toBe("view");
    expect(new Set(model.ceilings.insiders)).toEqual(
      new Set([ownerId, memberId, outsiderId]),
    );

    const node = (await adapterFor("conversation").loadNodes([chat.id])).get(
      chat.id,
    )!;
    const candidates = await takingPartCandidates(node, [
      memberId,
      viewerId,
      outsiderId,
      strangerId,
    ]);
    expect(candidates.map((person) => person.userId).sort()).toEqual(
      [memberId, outsiderId].sort(),
    );
  });

  test("someone who leaves the project reads their chats from then on", async () => {
    const chat = await chatOf(outsiderId);
    expect(await levelOf(outsiderId, chat.id)).toBe("full");

    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: projectId,
      principals: [{ type: "user", id: outsiderId }],
      level: "view",
    });
    expect(await levelOf(outsiderId, chat.id)).toBe("view");
  });
});

describe("the project's chats", () => {
  test("list what each person reads: their own, the ones opened to the project, the ones shared with them", async () => {
    const mine = await chatOf(memberId);
    const private_ = await chatOf(ownerId);
    const opened = await chatOf(ownerId);
    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "conversation",
      id: opened.id,
      restricted: false,
    });
    const sharedWithViewer = await chatOf(ownerId);
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "conversation",
      id: sharedWithViewer.id,
      principals: [{ type: "user", id: viewerId }],
      level: "view",
    });
    // A team chat is not the project's.
    await chatOf(memberId, false);

    const listed = async (userId: string) =>
      (
        await listProjectConversations({
          principal: await fx.principalOf(userId),
          projectId,
        })
      )
        .map((chat) => [chat.id, chat.level] as const)
        .sort(([a], [b]) => a.localeCompare(b));

    expect(await listed(memberId)).toEqual(
      [[mine.id, "full"] as const, [opened.id, "view"] as const].sort(
        ([a], [b]) => a.localeCompare(b),
      ),
    );
    expect(await listed(viewerId)).toEqual(
      [
        [opened.id, "view"] as const,
        [sharedWithViewer.id, "view"] as const,
      ].sort(([a], [b]) => a.localeCompare(b)),
    );
    expect((await listed(ownerId)).map(([id]) => id)).toContain(private_.id);
    expect(
      await refusal(
        listProjectConversations({
          principal: await fx.principalOf(strangerId),
          projectId,
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });
});
