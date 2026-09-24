import { and, eq, inArray, ne } from "drizzle-orm";
import { projectParticipants } from "../../../../authz/project-people";
import type { Executor } from "../../../../db";
import {
  aiConversationMembers,
  aiConversations,
  teamMember,
} from "../../../../db/schema";
import { throwHttpError } from "../../../../lib/errors";
import { ERROR_CODES } from "../../../../schemas/errors";
import type { GrantStore, StoredGrant, StoredHolder } from "../grant-store";
import type { PrincipalRef } from "../principals";
import { accessGrantStore } from "./access-grants";

/**
 * A chat keeps its participants in SEATS (`ai_conversation_members`), which
 * carry what taking part needs (unread, pins, notifications): a person who
 * takes part (`use`) is a seat, and whoever only reads it (`view`) — a
 * person, a team, the organization — a grant (`access_grants`). Moving a
 * person between the two moves the row, so the sharing services read and
 * write one list either way.
 *
 * The owner's seat is not a holder: the owner is the chat's owner, as every
 * resource's is, never someone to change or remove. And a seat is only ever
 * given to someone who works where the chat lives: its project's
 * participants when it is in one, else its team's people
 * (`authz/rules.ts` says why).
 */

const peopleOf = (refs: readonly PrincipalRef[]): string[] =>
  refs.flatMap((ref) => (ref.type === "user" ? [ref.id] : []));

/** The participants' seats of these people, locked, as the level they give. */
const lockSeats = async (
  tx: Executor,
  conversationId: string,
  userIds: readonly string[],
): Promise<StoredGrant[]> => {
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({ userId: aiConversationMembers.userId })
    .from(aiConversationMembers)
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        inArray(aiConversationMembers.userId, [...userIds]),
        ne(aiConversationMembers.role, "owner"),
      ),
    )
    .for("update");
  // A seat lasts while its holder takes part where the chat lives.
  return rows.map((row) => ({
    type: "user" as const,
    id: row.userId,
    level: "use" as const,
    expiresAt: null,
  }));
};

/**
 * Of these people, those who work where the chat lives: the participants of
 * its project when it is in one, else the people of its team.
 */
const whoWorksThere = async (
  tx: Executor,
  conversationId: string,
  userIds: readonly string[],
): Promise<{ readonly inProject: boolean; readonly ids: Set<string> }> => {
  const [chat] = await tx
    .select({
      organizationId: aiConversations.organizationId,
      teamId: aiConversations.teamId,
      projectId: aiConversations.projectId,
    })
    .from(aiConversations)
    .where(eq(aiConversations.id, conversationId));
  if (!chat) return { inProject: false, ids: new Set() };
  if (chat.projectId !== null) {
    return {
      inProject: true,
      ids: await projectParticipants({
        organizationId: chat.organizationId,
        projectId: chat.projectId,
        userIds,
        executor: tx,
      }),
    };
  }
  const inTeam = await tx
    .select({ userId: teamMember.userId })
    .from(teamMember)
    .where(
      and(
        eq(teamMember.teamId, chat.teamId),
        inArray(teamMember.userId, [...userIds]),
      ),
    );
  return { inProject: false, ids: new Set(inTeam.map((row) => row.userId)) };
};

/**
 * Seat these people as participants; a seat held stays as it is. Refused
 * when one of them does not work where the chat lives: they can read it.
 */
const takeSeats = async (
  tx: Executor,
  conversationId: string,
  userIds: readonly string[],
): Promise<void> => {
  if (userIds.length === 0) return;
  const insiders = await whoWorksThere(tx, conversationId, userIds);
  if (userIds.some((userId) => !insiders.ids.has(userId))) {
    throwHttpError(400, {
      code: ERROR_CODES.PARTICIPANT_OUTSIDE_TEAM,
      message: insiders.inProject
        ? "Only people who take part in the chat's project can take part in it. Give the others access to read it."
        : "Only people of the chat's team can take part in it. Give the others access to read it.",
    });
  }
  await tx
    .insert(aiConversationMembers)
    .values(
      userIds.map((userId) => ({
        conversationId,
        userId,
        role: "member" as const,
      })),
    )
    .onConflictDoNothing({
      target: [
        aiConversationMembers.conversationId,
        aiConversationMembers.userId,
      ],
    });
};

/** These people's seats, gone — never its owner's. */
const leaveSeats = async (
  tx: Executor,
  conversationId: string,
  userIds: readonly string[],
): Promise<void> => {
  if (userIds.length === 0) return;
  await tx
    .delete(aiConversationMembers)
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        inArray(aiConversationMembers.userId, [...userIds]),
        ne(aiConversationMembers.role, "owner"),
      ),
    );
};

export const conversationGrantStore: GrantStore = {
  lock: async (tx, resource, refs) => {
    const grants = await accessGrantStore.lock(tx, resource, refs);
    const seats = await lockSeats(tx, resource.id, peopleOf(refs));
    // A seat is the stronger of the two, and read after: a person who both
    // reads through a grant and takes part is listed as taking part.
    return [...grants, ...seats];
  },

  list: async (executor, resource): Promise<StoredHolder[]> => {
    const [grants, seats] = await Promise.all([
      accessGrantStore.list(executor, resource),
      executor
        .select({
          userId: aiConversationMembers.userId,
          joinedAt: aiConversationMembers.joinedAt,
        })
        .from(aiConversationMembers)
        .where(
          and(
            eq(aiConversationMembers.conversationId, resource.id),
            ne(aiConversationMembers.role, "owner"),
          ),
        ),
    ]);
    const seated = new Set(seats.map((seat) => seat.userId));
    return [
      ...grants.filter(
        (grant) => !(grant.type === "user" && seated.has(grant.id)),
      ),
      ...seats.map((seat): StoredHolder => ({
        type: "user",
        id: seat.userId,
        level: "use",
        expiresAt: null,
        grantedAt: seat.joinedAt,
        grantedBy: null,
      })),
    ];
  },

  upsert: async (tx, write) => {
    const people = write.refs.filter((ref) => ref.type === "user");
    // Taking part is a seat, never a grant beside it; reading, the reverse.
    if (write.level === "use") {
      await takeSeats(tx, write.resource.id, peopleOf(people));
      await accessGrantStore.remove(tx, write.resource, people);
      return;
    }
    await leaveSeats(tx, write.resource.id, peopleOf(people));
    await accessGrantStore.upsert(tx, write);
  },

  remove: async (tx, resource, refs) => {
    await leaveSeats(tx, resource.id, peopleOf(refs));
    await accessGrantStore.remove(tx, resource, refs);
  },
};
