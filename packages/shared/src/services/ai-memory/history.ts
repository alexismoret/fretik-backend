import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import db from "../../db";
import {
  aiMemoryHistory,
  type AiMemoryHistoryRow,
  type AiMemoryOperation,
} from "../../db/schema/ai-memory";
import type { MemoryActorContext } from "./types";

/**
 * Maximum number of historical versions kept per memory file.
 * The 21st write naturally evicts the oldest entry — keeps the
 * audit table bounded without a TTL job.
 */
export const HISTORY_RETENTION_PER_MEMORY = 20;

/**
 * Either the top-level `db` instance or a transaction handle from
 * `db.transaction(async (tx) => ...)`. Derived through `Parameters`
 * so we never have to import `PgTransaction` directly (the generic
 * type would force `any`).
 */
type TxCallback = Parameters<typeof db.transaction>[0];
export type DbExecutor = typeof db | Parameters<TxCallback>[0];

/**
 * Insert a single audit row inside the executor's scope. Caller
 * decides which fields to populate; unused columns stay null.
 *
 * Pure INSERT — no trim. Run inside the same transaction as the
 * memory write so the audit row never goes missing if the parent
 * write succeeds. The trim is fired separately via
 * `trimMemoryHistory` after the transaction commits.
 */
export const writeHistoryRow = async (
  executor: DbExecutor,
  args: {
    memoryId: string;
    teamId: string;
    operation: AiMemoryOperation;
    actor: MemoryActorContext;
    previousContent?: string | null;
    newContent?: string | null;
    previousPath?: string | null;
    newPath?: string | null;
    reason?: string | null;
  },
): Promise<AiMemoryHistoryRow> => {
  const [inserted] = await executor
    .insert(aiMemoryHistory)
    .values({
      memoryId: args.memoryId,
      teamId: args.teamId,
      operation: args.operation,
      previousContent: args.previousContent ?? null,
      newContent: args.newContent ?? null,
      previousPath: args.previousPath ?? null,
      newPath: args.newPath ?? null,
      byUserId: args.actor.userId,
      byActor: args.actor.actor,
      byConversationId: args.actor.conversationId ?? null,
      reason: args.reason ?? null,
    })
    .returning();
  if (!inserted) {
    throw new Error("Failed to insert ai_memory_history row");
  }
  return inserted;
};

/**
 * Trim the per-memory history to the most recent
 * `HISTORY_RETENTION_PER_MEMORY` entries. Best-effort hygiene —
 * runs OUTSIDE the originating transaction so a slow trim never
 * blocks the user-visible write. A small race (transient 21-22
 * rows) is acceptable; the next trim absorbs it.
 *
 * Awaited at the end of each mutating service so failures surface
 * in logs, but the parent operation has already returned the row.
 */
export const trimMemoryHistory = async (memoryId: string): Promise<void> => {
  const keepers = await db
    .select({ id: aiMemoryHistory.id })
    .from(aiMemoryHistory)
    .where(eq(aiMemoryHistory.memoryId, memoryId))
    .orderBy(desc(aiMemoryHistory.createdAt))
    .limit(HISTORY_RETENTION_PER_MEMORY);

  if (keepers.length < HISTORY_RETENTION_PER_MEMORY) return;

  await db.delete(aiMemoryHistory).where(
    and(
      eq(aiMemoryHistory.memoryId, memoryId),
      notInArray(
        aiMemoryHistory.id,
        keepers.map((r) => r.id),
      ),
    ),
  );
};

/**
 * Return the count of audit rows for a memoryId — used by the
 * "N versions retained" badge in the history modal.
 */
export const countMemoryHistory = async (memoryId: string): Promise<number> => {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiMemoryHistory)
    .where(eq(aiMemoryHistory.memoryId, memoryId));
  return rows[0]?.count ?? 0;
};
