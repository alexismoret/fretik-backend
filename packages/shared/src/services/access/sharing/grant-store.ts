import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { LoadedNode } from "../../../authz/resources/types";
import type { Executor } from "../../../db";
import {
  accessGrants,
  aiConversationMembers,
  aiConversations,
  teamMember,
} from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { ERROR_CODES } from "../../../schemas/errors";
import type { PrincipalRef } from "./principals";

/**
 * The explicit grants of one resource, as the sharing services change them.
 * Read and written inside the caller's transaction, row-locked, so two people
 * changing the same share at once cannot both believe they left someone with
 * full access.
 *
 * A chat keeps its participants in SEATS (`ai_conversation_members`), which
 * carry what taking part needs (unread, pins, notifications): a person who
 * takes part (`use`) is a seat, and whoever only reads it (`view`) — a
 * person, a team, the organization — a grant. Moving a person between the two
 * moves the row, so the sharing services read and write one list either way.
 * A seat is only ever given to someone of the chat's team (`rules.ts` says
 * why).
 */

export interface StoredGrant extends PrincipalRef {
  readonly level: AccessLevel;
}

/**
 * The participants' seats of these people in a chat, locked, as the level they
 * give. The owner's seat is not one: the owner is the chat's owner, as every
 * resource's is, never a holder to change or remove.
 */
const lockSeats = async (
  tx: Executor,
  conversationId: string,
  refs: readonly PrincipalRef[],
): Promise<StoredGrant[]> => {
  const userIds = refs.flatMap((ref) => (ref.type === "user" ? [ref.id] : []));
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({ userId: aiConversationMembers.userId })
    .from(aiConversationMembers)
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        inArray(aiConversationMembers.userId, userIds),
        ne(aiConversationMembers.role, "owner"),
      ),
    )
    .for("update");
  return rows.map((row) => ({
    type: "user" as const,
    id: row.userId,
    level: "use" as const,
  }));
};

/** The grants of the resource to these principals, locked for the change. */
export const lockGrants = async (
  tx: Executor,
  resource: { type: SharingResourceType; id: string },
  refs: readonly PrincipalRef[],
): Promise<StoredGrant[]> => {
  if (refs.length === 0) return [];
  const seats =
    resource.type === "conversation"
      ? await lockSeats(tx, resource.id, refs)
      : [];
  const rows = await tx
    .select({
      type: accessGrants.principalType,
      id: accessGrants.principalId,
      level: accessGrants.level,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, resource.type),
        eq(accessGrants.resourceId, resource.id),
        or(
          ...refs.map((ref) =>
            and(
              eq(accessGrants.principalType, ref.type),
              eq(accessGrants.principalId, ref.id),
            ),
          ),
        ),
      ),
    )
    .for("update");
  return [
    ...rows.flatMap((row) =>
      row.type === "invitation" ? [] : [{ ...row, type: row.type }],
    ),
    // A seat is the stronger of the two, and read after: a person who both
    // reads through a grant and takes part is listed as taking part.
    ...seats,
  ];
};

/**
 * Refuse a change that would leave a restricted resource with no owner and
 * nobody with full access. `losing` are the grants the change removes or
 * lowers below full; they are not counted.
 */
export const assertSomeoneKeepsFullAccess = async (
  tx: Executor,
  node: LoadedNode,
  losing: readonly PrincipalRef[],
): Promise<void> => {
  if (!node.restricted || node.ownerUserId !== null || losing.length === 0) {
    return;
  }
  const [row] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, node.type),
        eq(accessGrants.resourceId, node.id),
        eq(accessGrants.level, "full"),
        ne(accessGrants.principalType, "invitation"),
        ...losing.map(
          (ref) =>
            sql`NOT (${accessGrants.principalType} = ${ref.type} AND ${accessGrants.principalId} = ${ref.id})`,
        ),
      ),
    );
  if ((row?.count ?? 0) === 0) {
    throwHttpError(409, {
      code: ERROR_CODES.LAST_FULL_ACCESS,
      message:
        "Someone must keep full access to this item: its owner is gone and it is restricted.",
    });
  }
};

/** Write these grants at `level`, created or changed, in one statement. */
export const upsertGrants = async (
  tx: Executor,
  input: {
    organizationId: string;
    resource: { type: SharingResourceType; id: string };
    refs: readonly PrincipalRef[];
    level: AccessLevel;
    actorUserId: string;
  },
): Promise<void> => {
  if (input.refs.length === 0) return;
  if (input.resource.type === "conversation") {
    const people = input.refs.filter((ref) => ref.type === "user");
    // Taking part is a seat, never a grant beside it; reading, the reverse.
    if (input.level === "use") {
      await takeSeats(tx, input.resource.id, people);
      await deleteGrantRows(tx, input.resource, people);
      return;
    }
    await leaveSeats(tx, input.resource.id, people);
  }
  await tx
    .insert(accessGrants)
    .values(
      input.refs.map((ref) => ({
        organizationId: input.organizationId,
        resourceType: input.resource.type,
        resourceId: input.resource.id,
        principalType: ref.type,
        principalId: ref.id,
        level: input.level,
        grantedByUserId: input.actorUserId,
      })),
    )
    .onConflictDoUpdate({
      target: [
        accessGrants.resourceType,
        accessGrants.resourceId,
        accessGrants.principalType,
        accessGrants.principalId,
      ],
      set: {
        level: input.level,
        grantedByUserId: input.actorUserId,
        // A share made again is a share without an end date.
        expiresAt: null,
      },
    });
};

/** Remove these grants, and a chat's seats with them. */
export const deleteGrants = async (
  tx: Executor,
  resource: { type: SharingResourceType; id: string },
  refs: readonly PrincipalRef[],
): Promise<void> => {
  if (refs.length === 0) return;
  if (resource.type === "conversation") {
    await leaveSeats(
      tx,
      resource.id,
      refs.filter((ref) => ref.type === "user"),
    );
  }
  await deleteGrantRows(tx, resource, refs);
};

/** The grant rows of these principals, gone. */
const deleteGrantRows = async (
  tx: Executor,
  resource: { type: SharingResourceType; id: string },
  refs: readonly PrincipalRef[],
): Promise<void> => {
  if (refs.length === 0) return;
  await tx
    .delete(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, resource.type),
        eq(accessGrants.resourceId, resource.id),
        or(
          ...refs.map((ref) =>
            and(
              eq(accessGrants.principalType, ref.type),
              eq(accessGrants.principalId, ref.id),
            ),
          ),
        ),
      ),
    );
};

/**
 * Seat these people in a chat as participants; a seat held stays as it is.
 * Refused when one of them is not in the chat's team: they can read it.
 */
const takeSeats = async (
  tx: Executor,
  conversationId: string,
  people: readonly PrincipalRef[],
): Promise<void> => {
  if (people.length === 0) return;
  const inTeam = await tx
    .select({ userId: teamMember.userId })
    .from(aiConversations)
    .innerJoin(teamMember, eq(teamMember.teamId, aiConversations.teamId))
    .where(
      and(
        eq(aiConversations.id, conversationId),
        inArray(
          teamMember.userId,
          people.map((person) => person.id),
        ),
      ),
    );
  const members = new Set(inTeam.map((row) => row.userId));
  if (people.some((person) => !members.has(person.id))) {
    throwHttpError(400, {
      code: ERROR_CODES.PARTICIPANT_OUTSIDE_TEAM,
      message:
        "Only people of the chat's team can take part in it. Give the others access to read it.",
    });
  }
  await tx
    .insert(aiConversationMembers)
    .values(
      people.map((person) => ({
        conversationId,
        userId: person.id,
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

/** These people's seats in a chat, gone — never its owner's. */
const leaveSeats = async (
  tx: Executor,
  conversationId: string,
  people: readonly PrincipalRef[],
): Promise<void> => {
  if (people.length === 0) return;
  await tx.delete(aiConversationMembers).where(
    and(
      eq(aiConversationMembers.conversationId, conversationId),
      inArray(
        aiConversationMembers.userId,
        people.map((person) => person.id),
      ),
      ne(aiConversationMembers.role, "owner"),
    ),
  );
};
