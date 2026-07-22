import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import {
  aiMemories,
  aiMemoryHistory,
  type AiMemoryScope,
} from "../../db/schema/ai-memory";
import { forbidden, throwHttpError } from "../../lib/errors";
import { toDomainEventActor } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import type { MemoryScopeKey } from "./types";
import { deleteMemoryVectorsBulk } from "./vector-refresh";

/**
 * Bulk "reset" of memory NOTES (hard delete — notes carry their own audit
 * trail, unlike episodes which soft-hide):
 *   - `scope='user'` deletes the caller's own `user`-scope notes.
 *   - `scope='team'` (admin only) deletes EVERY note in the team (both
 *     scopes, all members).
 * Each removed file leaves a final `delete` history row + a `memory.deleted`
 * journal entry so the activity panel still explains the wipe, then their RAG
 * vectors are dropped in one set-based DELETE (no FK from `ai_vectors`).
 */
export const deleteAllMemories = async (input: {
  scopeKey: MemoryScopeKey;
  scope: AiMemoryScope;
  isAdmin: boolean;
}): Promise<{ deleted: number }> => {
  if (input.scope === "team" && !input.isAdmin) {
    return throwHttpError(
      403,
      forbidden("Only an admin can delete team memory"),
    );
  }

  const conditions = [
    eq(aiMemories.organizationId, input.scopeKey.organizationId),
    eq(aiMemories.teamId, input.scopeKey.teamId),
  ];
  if (input.scope === "user") {
    conditions.push(eq(aiMemories.scope, "user"));
    conditions.push(eq(aiMemories.userId, input.scopeKey.userId));
  }

  const targets = await db
    .select({
      id: aiMemories.id,
      path: aiMemories.path,
      scope: aiMemories.scope,
      content: aiMemories.content,
      teamId: aiMemories.teamId,
    })
    .from(aiMemories)
    .where(and(...conditions));

  if (targets.length === 0) return { deleted: 0 };
  const ids = targets.map((m) => m.id);

  await db.transaction(async (tx) => {
    // Audit rows BEFORE the delete — the FK (`memoryId` set null on delete)
    // keeps the "delete" entry so the activity feed can still surface it.
    await tx.insert(aiMemoryHistory).values(
      targets.map((m) => ({
        memoryId: m.id,
        teamId: m.teamId,
        operation: "delete" as const,
        previousContent: m.content,
        previousPath: m.path,
        byUserId: input.scopeKey.userId,
        byActor: "human" as const,
      })),
    );
    await emitDomainEventsBulk({
      tx,
      organizationId: input.scopeKey.organizationId,
      teamId: input.scopeKey.teamId,
      actor: toDomainEventActor({
        byActor: "human",
        userId: input.scopeKey.userId,
      }),
      events: targets.map((m) => ({
        type: "memory.deleted" as const,
        subjectType: "memory",
        payload: { path: m.path, scope: m.scope },
        dedupKey: `memory.deleted:${m.id}`,
      })),
    });
    await tx.delete(aiMemories).where(inArray(aiMemories.id, ids));
  });

  void deleteMemoryVectorsBulk(ids);

  return { deleted: targets.length };
};
