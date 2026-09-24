import { type SQL, sql } from "drizzle-orm";
import { requireAccess, resolveAccessMany } from "../../authz/access";
import type { UserPrincipal } from "../../authz/principal";
import { containerArm, grantArm } from "../../authz/sql";
import db from "../../db";
import type { aiConversations } from "../../db/schema";
import {
  conversationWith,
  serializeConversation,
  type SerializedConversation,
} from "./conversation-serializer";

/** A project's page of chats: the most recently active first. */
export const PROJECT_CONVERSATIONS_MAX = 100;

/**
 * The chats of a project the caller can read: the ones they take part in,
 * the ones opened to the project, and the ones shared with them (by name, or
 * with one of their teams, the project or the whole organization).
 *
 * Unlike the chat list, which holds the chats one takes part in, this is the
 * project's own: a chat opened to it is there for everyone in it, seat or
 * not. Each comes with the caller's level on it, as the engine decides.
 */
export const listProjectConversations = async (input: {
  principal: UserPrincipal;
  projectId: string;
  search?: string;
  limit?: number;
}): Promise<SerializedConversation[]> => {
  const { principal, projectId } = input;
  await requireAccess({
    principal,
    type: "project",
    id: projectId,
    required: "view",
    notFoundMessage: "Project not found",
  });

  const rows = await db.query.aiConversations.findMany({
    where: {
      organizationId: principal.organizationId,
      projectId,
      agentType: "chatbot",
      ...(input.search ? { title: { ilike: `%${input.search}%` } } : {}),
      RAW: (table) => readableChat(principal, table),
    },
    with: conversationWith,
    orderBy: { updatedAt: "desc" },
    limit: Math.min(input.limit ?? 50, PROJECT_CONVERSATIONS_MAX),
  });

  const levels = await resolveAccessMany(
    principal,
    "conversation",
    rows.map((row) => row.id),
  );
  return rows.flatMap((row) => {
    const resolved = levels.get(row.id);
    return resolved === undefined
      ? []
      : [serializeConversation(row, principal.userId, resolved.level)];
  });
};

/**
 * A chat the person reads: a seat in it, the chat open to where it lives and
 * that place readable to them, or a grant to read it. The engine decides the
 * exact level of each row afterwards (`resolveAccessMany`); this only keeps
 * the query to the rows it would find.
 */
const readableChat = (
  principal: UserPrincipal,
  table: typeof aiConversations,
): SQL =>
  sql`(
    EXISTS (
      SELECT 1 FROM ai_conversation_members m
      WHERE m.conversation_id = ${table.id} AND m.user_id = ${principal.userId}
    )
    OR (NOT ${table.accessRestricted} AND ${containerArm({
      principal,
      level: "view",
      teamId: table.teamId,
      projectId: table.projectId,
    })})
    OR ${grantArm({
      principal,
      level: "view",
      resourceType: "conversation",
      resourceId: table.id,
    })}
  )`;
