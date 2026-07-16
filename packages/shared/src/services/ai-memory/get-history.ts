import db from "../../db";
import type {
  AiMemoryActor,
  AiMemoryOperation,
} from "../../db/schema/ai-memory";
import { getMemoryContent } from "./get-content";
import { parseMemoryOperation } from "./operation";

/**
 * Per-file history entry surfaced in the Historique modal. Mirrors
 * the audit table shape with `byUser` flattened for the UI.
 */
export interface MemoryHistoryEntry {
  id: string;
  operation: AiMemoryOperation;
  previousContent: string | null;
  newContent: string | null;
  previousPath: string | null;
  newPath: string | null;
  byUser: { userId: string | null; name: string | null };
  byActor: AiMemoryActor;
  byConversationId: string | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * Return the per-file audit timeline (most-recent first) for the
 * Historique modal. `null` when the caller is not allowed to see the
 * memory — the handler maps it to a 404. Cap at the retention size
 * (20 — see `history.ts::HISTORY_RETENTION_PER_MEMORY`); the trim
 * already keeps the table bounded but we hard-cap on read so a stray
 * unbounded query can never blow up the payload.
 */
export const getMemoryHistory = async (args: {
  memoryId: string;
  organizationId: string;
  teamId: string;
  currentUserId: string;
}): Promise<MemoryHistoryEntry[] | null> => {
  // Visibility check first — returns null if the parent memory is
  // hidden, so we never reveal history rows for a row the caller has
  // no access to.
  const visible = await getMemoryContent({
    id: args.memoryId,
    organizationId: args.organizationId,
    teamId: args.teamId,
    currentUserId: args.currentUserId,
  });
  if (!visible) return null;

  const rows = await db.query.aiMemoryHistory.findMany({
    where: {
      memoryId: args.memoryId,
      teamId: args.teamId,
    },
    with: {
      byUser: { columns: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    limit: 20,
  });

  return rows.map((row): MemoryHistoryEntry => ({
    id: row.id,
    operation: parseMemoryOperation(row.operation),
    previousContent: row.previousContent,
    newContent: row.newContent,
    previousPath: row.previousPath,
    newPath: row.newPath,
    byUser: {
      userId: row.byUserId,
      name: row.byUser?.name ?? null,
    },
    byActor: row.byActor,
    byConversationId: row.byConversationId,
    reason: row.reason,
    createdAt: row.createdAt,
  }));
};
