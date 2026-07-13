import { eq } from "drizzle-orm";
import db from "../../db";
import { aiMemories } from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import { emitDomainEvent, toDomainEventActor } from "../domain-events/emit";
import { writeHistoryRow } from "./history";
import { findMemoryByPath } from "./lookup";
import { formatMemoryPath, parseMemoryPath } from "./paths";
import type { MemoryActorContext, MemoryScopeKey } from "./types";
import { deleteMemoryVectors } from "./vector-refresh";

/**
 * Delete a single memory file.
 *
 * The audit row is written BEFORE the row vanishes (FK is set to
 * `cascade` on `ai_memories.id` so once the parent goes, the
 * history rows for it would be wiped — we keep the *delete event*
 * itself as a final history record so the activity panel can still
 * surface "X deleted memory Y on date".
 *
 * Service signature accepts a `reason` so the settings UI can ask
 * "why?" and feed it into the audit log. The `memory` tool calls
 * this without a reason — the agent never volunteers one.
 */
export const deleteMemory = async (args: {
  rawPath: string;
  scopeKey: MemoryScopeKey;
  actor: MemoryActorContext;
  reason?: string;
}): Promise<void> => {
  const parsed = parseMemoryPath(args.rawPath);

  const existing = await findMemoryByPath({
    scope: parsed.scope,
    relativePath: parsed.relativePath,
    scopeKey: args.scopeKey,
  });
  if (!existing) {
    return throwHttpError(
      404,
      createApiError(
        "MEMORY_FILE_NOT_FOUND",
        `Memory file not found at ${formatMemoryPath(parsed)}`,
      ),
    );
  }

  await db.transaction(async (tx) => {
    // Record the delete BEFORE the actual DELETE — the FK cascades
    // would otherwise wipe sibling history rows. The "delete" entry
    // survives because we capture it just before the parent goes.
    await writeHistoryRow(tx, {
      memoryId: existing.id,
      teamId: existing.teamId,
      operation: "delete",
      actor: args.actor,
      previousContent: existing.content,
      previousPath: existing.path,
      reason: args.reason ?? null,
    });

    await emitDomainEvent({
      tx,
      organizationId: args.scopeKey.organizationId,
      teamId: args.scopeKey.teamId,
      type: "memory.deleted",
      actor: toDomainEventActor({
        byActor: args.actor.actor,
        userId: args.actor.userId,
        conversationId: args.actor.conversationId,
      }),
      subjectType: "memory",
      payload: { path: existing.path, scope: existing.scope },
      dedupKey: `memory.deleted:${existing.id}`,
    });

    await tx.delete(aiMemories).where(eq(aiMemories.id, existing.id));
  });

  // Cascade RAG vectors. Fire-and-forget: a failure to clean up
  // vectors leaves orphan rows but never blocks (or rolls back) the
  // user-visible delete. `ai_vectors` has no FK to `ai_memories`, so
  // we have to issue this DELETE explicitly.
  void deleteMemoryVectors(existing.id);
};
