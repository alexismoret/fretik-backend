import { eq } from "drizzle-orm";
import db from "../../db";
import { aiMemories, type AiMemory } from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import { emitDomainEvent, toDomainEventActor } from "../domain-events/emit";
import { trimMemoryHistory, writeHistoryRow } from "./history";
import { findMemoryByPath } from "./lookup";
import { MEMORY_MAX_BYTES, memoryByteSize, parseMemoryPath } from "./paths";
import type { MemoryActorContext, MemoryScopeKey } from "./types";
import { triggerMemoryVectorRefresh } from "./vector-refresh";

/**
 * Replace OR create a memory file in a single atomic operation.
 *
 * This is the model's main update path — `view → overwrite` is two
 * tool calls (vs three for `view → delete → create`) and avoids:
 *
 *  - the visibility window where the file does not exist (a
 *    concurrent grep/view from another conversation would see a hole);
 *  - the silent-overwrite race where User B's update lands between
 *    User A's read and write (User A would still clobber B's full
 *    content; here, User A's write at least surfaces in the history
 *    so B can recover the lost diff).
 *
 * The audit row records `operation = 'overwrite'` (with previous
 * content) when the path already existed, or `'create'` when it was
 * a fresh insert — same semantics as `create.ts` for the latter case
 * so the activity panel sees a coherent story.
 */
export const overwriteMemory = async (args: {
  rawPath: string;
  content: string;
  scopeKey: MemoryScopeKey;
  actor: MemoryActorContext;
}): Promise<{ memory: AiMemory; created: boolean }> => {
  const parsed = parseMemoryPath(args.rawPath);

  const sizeBytes = memoryByteSize(args.content);
  if (sizeBytes > MEMORY_MAX_BYTES) {
    return throwHttpError(
      400,
      createApiError(
        "MEMORY_TOO_LARGE",
        `Memory content exceeds ${MEMORY_MAX_BYTES.toString()} bytes (got ${sizeBytes.toString()}).`,
      ),
    );
  }

  const result = await db.transaction(async (tx) => {
    const existing = await findMemoryByPath({
      scope: parsed.scope,
      relativePath: parsed.relativePath,
      scopeKey: args.scopeKey,
    });

    if (existing) {
      const [updated] = await tx
        .update(aiMemories)
        .set({
          content: args.content,
          sizeBytes,
          lastModifiedByUserId: args.actor.userId,
          lastModifiedByActor: args.actor.actor,
          lastModifiedByConversationId: args.actor.conversationId ?? null,
        })
        .where(eq(aiMemories.id, existing.id))
        .returning();
      if (!updated) {
        return throwHttpError(
          500,
          createApiError("INTERNAL_ERROR", "Failed to overwrite memory"),
        );
      }

      await writeHistoryRow(tx, {
        memoryId: updated.id,
        teamId: updated.teamId,
        operation: "overwrite",
        actor: args.actor,
        previousContent: existing.content,
        newContent: args.content,
      });

      await emitDomainEvent({
        tx,
        organizationId: args.scopeKey.organizationId,
        teamId: args.scopeKey.teamId,
        type: "memory.updated",
        actor: toDomainEventActor({
          byActor: args.actor.actor,
          userId: args.actor.userId,
          conversationId: args.actor.conversationId,
        }),
        subjectType: "memory",
        payload: { path: updated.path, scope: updated.scope },
      });

      return { memory: updated, created: false };
    }

    const [created] = await tx
      .insert(aiMemories)
      .values({
        organizationId: args.scopeKey.organizationId,
        teamId: args.scopeKey.teamId,
        scope: parsed.scope,
        userId: parsed.scope === "user" ? args.scopeKey.userId : null,
        path: parsed.relativePath,
        content: args.content,
        sizeBytes,
        createdByUserId: args.actor.userId,
        createdByActor: args.actor.actor,
        createdByConversationId: args.actor.conversationId ?? null,
        lastModifiedByUserId: args.actor.userId,
        lastModifiedByActor: args.actor.actor,
        lastModifiedByConversationId: args.actor.conversationId ?? null,
      })
      .returning();
    if (!created) {
      return throwHttpError(
        500,
        createApiError("INTERNAL_ERROR", "Failed to create memory"),
      );
    }

    await writeHistoryRow(tx, {
      memoryId: created.id,
      teamId: created.teamId,
      operation: "create",
      actor: args.actor,
      newContent: args.content,
    });

    // Fresh insert through the overwrite path — same journal semantics as
    // `create.ts`, mirroring the history row's `operation: "create"`.
    await emitDomainEvent({
      tx,
      organizationId: args.scopeKey.organizationId,
      teamId: args.scopeKey.teamId,
      type: "memory.created",
      actor: toDomainEventActor({
        byActor: args.actor.actor,
        userId: args.actor.userId,
        conversationId: args.actor.conversationId,
      }),
      subjectType: "memory",
      payload: { path: created.path, scope: created.scope },
      dedupKey: `memory.created:${created.id}`,
    });

    return { memory: created, created: true };
  });

  await trimMemoryHistory(result.memory.id);
  // Fire-and-forget RAG re-indexing — `upsertVectors` is idempotent
  // (DELETE by source_id then INSERT) so the same call covers both
  // overwrite-existing and overwrite-as-create branches above.
  void triggerMemoryVectorRefresh(
    result.memory.id,
    result.memory.teamId,
    result.memory.organizationId,
  );
  return result;
};
