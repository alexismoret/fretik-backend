import db from "../../db";
import { aiMemories, type AiMemory } from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import { trimMemoryHistory, writeHistoryRow } from "./history";
import { findMemoryByPath } from "./lookup";
import {
  formatMemoryPath,
  MEMORY_MAX_BYTES,
  memoryByteSize,
  parseMemoryPath,
} from "./paths";
import type { MemoryActorContext, MemoryScopeKey } from "./types";
import { triggerMemoryVectorRefresh } from "./vector-refresh";

/**
 * Create a new memory file. Fails if the path already exists in
 * the same scope — mirroring Anthropic's `create` semantics so the
 * tool description (and any future swap to the native tool) stays
 * consistent.
 *
 * The model is expected to call `overwrite` when it wants to
 * replace existing content. We don't merge `create` and
 * `overwrite` — the distinction matters for audit (`operation`)
 * and lets the activity panel surface "fresh memorisation" vs
 * "evolving knowledge" separately.
 */
export const createMemory = async (args: {
  rawPath: string;
  content: string;
  scopeKey: MemoryScopeKey;
  actor: MemoryActorContext;
}): Promise<AiMemory> => {
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

  // Pre-flight existence check inside the transaction to map a
  // conflict to MEMORY_FILE_EXISTS without hand-decoding PG errors.
  // The partial unique index still protects against races: a parallel
  // INSERT that wins between this SELECT and ours surfaces as a
  // duplicate-key violation, which we map to the same code below.
  return await db
    .transaction(async (tx) => {
      const existing = await findMemoryByPath({
        scope: parsed.scope,
        relativePath: parsed.relativePath,
        scopeKey: args.scopeKey,
      });
      if (existing) {
        return throwHttpError(
          409,
          createApiError(
            "MEMORY_FILE_EXISTS",
            `Memory file already exists at ${formatMemoryPath(parsed)}`,
          ),
        );
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

      // Fire trim AFTER the transaction commits — handled by the caller
      // via `trimMemoryHistory(memoryId)`. We expose it here as a
      // convenience: services awaiting `createMemory(...)` get the row
      // back, then we async-await the trim before resolving so log
      // failures still surface, but don't roll back the create.
      return created;
    })
    .then(async (created) => {
      await trimMemoryHistory(created.id);
      // Fire-and-forget RAG indexing — the memory row is the source of
      // truth, so vectorisation must never block (or roll back) the
      // user-visible create. `triggerMemoryVectorRefresh` swallows
      // errors internally.
      void triggerMemoryVectorRefresh(
        created.id,
        created.teamId,
        created.organizationId,
      );
      return created;
    });
};
