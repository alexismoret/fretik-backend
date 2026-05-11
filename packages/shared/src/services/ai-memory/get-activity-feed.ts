import { and, eq, lt, sql } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema/ai";
import {
  aiMemories,
  aiMemoryHistory,
  type AiMemoryActor,
  type AiMemoryScope,
} from "../../db/schema/ai-memory";
import { parseMemoryOperation } from "./operation";

const MAX_TRIGGERING_MESSAGE_CHARS = 600;

/**
 * Cross-memory activity entry surfaced in the team-shared "Memory
 * activity" panel. RGPD constraint: the `triggeringUserMessage` field
 * is filled ONLY when the audit row's `byUserId` matches the caller —
 * a user must never read another teammate's prompt content. The diff
 * (path + content) is still shown to everyone, hence the strict
 * scope='team' filter so private user memories never bleed across.
 */
export interface MemoryFeedbackEntry {
  id: string;
  memoryId: string | null;
  scope: AiMemoryScope;
  path: string;
  operation: ReturnType<typeof parseMemoryOperation>;
  previousContent: string | null;
  newContent: string | null;
  previousPath: string | null;
  newPath: string | null;
  byUser: { userId: string | null; name: string | null };
  byActor: AiMemoryActor;
  byConversationId: string | null;
  reason: string | null;
  createdAt: Date;
  triggeringUserMessage: string | null;
}

/**
 * Best-effort excerpt of the user message that triggered the write.
 * We grab the LAST `role='user'` message in the conversation that
 * precedes the audit row — the agent always processes the most recent
 * user turn before issuing tool calls.
 *
 * Only invoked for the caller's own audit rows (RGPD), so reading a
 * `parts[0].text` directly is safe: even if a message contained file
 * parts before text, the leak risk is bounded to the caller's own
 * past prompts.
 */
const fetchTriggeringMessage = async (args: {
  conversationId: string;
  before: Date;
}): Promise<string | null> => {
  const row = await db
    .select({ parts: aiMessages.parts })
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, args.conversationId),
        eq(aiMessages.role, "user"),
        lt(aiMessages.createdAt, args.before),
      ),
    )
    .orderBy(sql`${aiMessages.createdAt} desc`)
    .limit(1);

  const parts = row[0]?.parts;
  if (!parts || !Array.isArray(parts)) return null;

  for (const part of parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      const text = part.text.trim();
      if (text.length === 0) continue;
      return text.length > MAX_TRIGGERING_MESSAGE_CHARS
        ? `${text.slice(0, MAX_TRIGGERING_MESSAGE_CHARS)}…`
        : text;
    }
  }
  return null;
};

/**
 * List the latest `byActor='agent'` writes against team memories of
 * the active team. Drives the "Memory activity" settings panel.
 *
 * Filtering rules:
 *  - team scope only — joining `ai_memories` and filtering on
 *    `scope='team'`. User-scope writes are private to their owner and
 *    must never appear in a team-shared panel.
 *  - drops audit rows whose parent memory has been deleted (`memoryId
 *    IS NULL` after `ON DELETE SET NULL`). Without a denormalised
 *    `scope` column on the audit table we cannot tell whether such
 *    rows belonged to a private memory; safer to hide.
 *  - `triggeringUserMessage` filled only when `byUserId === currentUserId`.
 *
 * Pagination via `limit` / `offset` (cap enforced by the schema).
 * `total` is computed via a separate count query — keeps the main
 * query simple at the cost of one extra round-trip.
 */
export const getMemoryActivityFeed = async (args: {
  organizationId: string;
  teamId: string;
  currentUserId: string;
  limit: number;
  offset: number;
}): Promise<{ entries: MemoryFeedbackEntry[]; total: number }> => {
  const baseWhere = and(
    eq(aiMemoryHistory.teamId, args.teamId),
    eq(aiMemoryHistory.byActor, "agent"),
    eq(aiMemories.scope, "team"),
    eq(aiMemories.organizationId, args.organizationId),
  );

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        history: aiMemoryHistory,
        memoryScope: aiMemories.scope,
        memoryPath: aiMemories.path,
      })
      .from(aiMemoryHistory)
      .innerJoin(aiMemories, eq(aiMemoryHistory.memoryId, aiMemories.id))
      .where(baseWhere)
      .orderBy(sql`${aiMemoryHistory.createdAt} desc`)
      .limit(args.limit)
      .offset(args.offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiMemoryHistory)
      .innerJoin(aiMemories, eq(aiMemoryHistory.memoryId, aiMemories.id))
      .where(baseWhere),
  ]);

  // Resolve `byUser.name` and triggering messages in parallel —
  // bounded by `limit` (≤ 50). No need for a join: the panel will
  // be infrequently hit and 50 small lookups are well under 100ms.
  const byUserIds = [
    ...new Set(
      rows
        .map((r) => r.history.byUserId)
        .filter((v): v is string => v !== null),
    ),
  ];
  const userRows = byUserIds.length
    ? await db.query.user.findMany({
        where: { id: { in: byUserIds } },
        columns: { id: true, name: true },
      })
    : [];
  const namesById = new Map(userRows.map((u) => [u.id, u.name]));

  const enriched = await Promise.all(
    rows.map(async (r): Promise<MemoryFeedbackEntry> => {
      const isOwn =
        r.history.byUserId !== null &&
        r.history.byUserId === args.currentUserId;
      const triggeringUserMessage =
        isOwn && r.history.byConversationId
          ? await fetchTriggeringMessage({
              conversationId: r.history.byConversationId,
              before: r.history.createdAt,
            })
          : null;

      return {
        id: r.history.id,
        memoryId: r.history.memoryId,
        scope: r.memoryScope,
        path: r.memoryPath,
        operation: parseMemoryOperation(r.history.operation),
        previousContent: r.history.previousContent,
        newContent: r.history.newContent,
        previousPath: r.history.previousPath,
        newPath: r.history.newPath,
        byUser: {
          userId: r.history.byUserId,
          name: r.history.byUserId
            ? (namesById.get(r.history.byUserId) ?? null)
            : null,
        },
        byActor: r.history.byActor,
        byConversationId: r.history.byConversationId,
        reason: r.history.reason,
        createdAt: r.history.createdAt,
        triggeringUserMessage,
      };
    }),
  );

  return {
    entries: enriched,
    total: totalRow[0]?.count ?? 0,
  };
};
