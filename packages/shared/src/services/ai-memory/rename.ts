import { eq } from "drizzle-orm";
import db from "../../db";
import { aiMemories, type AiMemory } from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import { emitDomainEvent, toDomainEventActor } from "../domain-events/emit";
import { trimMemoryHistory, writeHistoryRow } from "./history";
import { findMemoryByPath } from "./lookup";
import { formatMemoryPath, parseMemoryPath } from "./paths";
import type { MemoryActorContext, MemoryScopeKey } from "./types";
import { triggerMemoryVectorRefresh } from "./vector-refresh";

/**
 * Rename / move a memory file. Both paths must live in the same
 * namespace — cross-scope renames are rejected because they would
 * require flipping `scope` (and changing `userId`), which would
 * effectively transfer ownership across the user/team boundary.
 *
 * The model can use rename to reorganise (e.g. flatten an
 * accidentally-nested file, or migrate `vendors/acme` →
 * `vendors/acme-supplies.md`). For cross-scope migrations, the right
 * primitive is `view` + `create` + `delete`.
 */
export const renameMemory = async (args: {
  oldRawPath: string;
  newRawPath: string;
  scopeKey: MemoryScopeKey;
  actor: MemoryActorContext;
}): Promise<AiMemory> => {
  const oldParsed = parseMemoryPath(args.oldRawPath);
  const newParsed = parseMemoryPath(args.newRawPath);

  if (oldParsed.scope !== newParsed.scope) {
    return throwHttpError(
      400,
      createApiError(
        "MEMORY_INVALID_PATH",
        "Cannot rename across namespaces (user ↔ team). Use view + create + delete instead.",
      ),
    );
  }
  if (oldParsed.relativePath === newParsed.relativePath) {
    return throwHttpError(
      400,
      createApiError(
        "MEMORY_INVALID_PATH",
        "old_path and new_path are identical; nothing to rename.",
      ),
    );
  }

  return await db
    .transaction(async (tx) => {
      const source = await findMemoryByPath({
        scope: oldParsed.scope,
        relativePath: oldParsed.relativePath,
        scopeKey: args.scopeKey,
      });
      if (!source) {
        return throwHttpError(
          404,
          createApiError(
            "MEMORY_FILE_NOT_FOUND",
            `Memory file not found at ${formatMemoryPath(oldParsed)}`,
          ),
        );
      }

      const conflict = await findMemoryByPath({
        scope: newParsed.scope,
        relativePath: newParsed.relativePath,
        scopeKey: args.scopeKey,
      });
      if (conflict) {
        return throwHttpError(
          409,
          createApiError(
            "MEMORY_RENAME_DEST_EXISTS",
            `Destination already exists at ${formatMemoryPath(newParsed)}`,
          ),
        );
      }

      const [updated] = await tx
        .update(aiMemories)
        .set({
          path: newParsed.relativePath,
          lastModifiedByUserId: args.actor.userId,
          lastModifiedByActor: args.actor.actor,
          lastModifiedByConversationId: args.actor.conversationId ?? null,
        })
        .where(eq(aiMemories.id, source.id))
        .returning();
      if (!updated) {
        return throwHttpError(
          500,
          createApiError("INTERNAL_ERROR", "Failed to rename memory"),
        );
      }

      await writeHistoryRow(tx, {
        memoryId: updated.id,
        teamId: updated.teamId,
        operation: "rename",
        actor: args.actor,
        previousPath: source.path,
        newPath: updated.path,
      });

      await emitDomainEvent({
        tx,
        organizationId: args.scopeKey.organizationId,
        teamId: args.scopeKey.teamId,
        type: "memory.renamed",
        actor: toDomainEventActor({
          byActor: args.actor.actor,
          userId: args.actor.userId,
          conversationId: args.actor.conversationId,
        }),
        subjectType: "memory",
        payload: {
          fromPath: source.path,
          toPath: updated.path,
          scope: updated.scope,
        },
      });

      return updated;
    })
    .then(async (updated) => {
      await trimMemoryHistory(updated.id);
      // Path is part of the memory's contextual prefix (`[TEAM_MEMORY]
      // path:vendors/acme.md`), so a rename invalidates every existing
      // vector chunk's prefix — re-vectorise. `upsertVectors` clears
      // stale rows by `(source_type, source_id)` before inserting.
      void triggerMemoryVectorRefresh(
        updated.id,
        updated.teamId,
        updated.organizationId,
      );
      return updated;
    });
};
