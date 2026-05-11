import db from "../../db";
import { createApiError, throwHttpError } from "../../lib/errors";
import type { MemorySummary } from "./list-for-ui";

/**
 * Settings UI payload for the "Voir" / "Éditer" modal — the full
 * content + the same metadata the list view returns. Splitting it from
 * `MemorySummary` keeps the list endpoint cheap (no `content` column
 * loaded for N rows just to display sizes).
 */
export interface MemoryContent extends MemorySummary {
  content: string;
}

/**
 * Load a single memory by its UUID, scoped to what `currentUserId`
 * is allowed to see:
 *
 *  - team-scope rows of the active team are visible to every member;
 *  - user-scope rows are visible only to their owner.
 *
 * Returns `null` if the row does not exist or belongs to another
 * user / team — the handler maps it to a 404 so we never hint at
 * existence cross-tenant.
 */
export const getMemoryContent = async (args: {
  id: string;
  organizationId: string;
  teamId: string;
  currentUserId: string;
}): Promise<MemoryContent | null> => {
  const row = await db.query.aiMemories.findFirst({
    where: {
      id: args.id,
      organizationId: args.organizationId,
      teamId: args.teamId,
      OR: [{ scope: "team" }, { scope: "user", userId: args.currentUserId }],
    },
    with: {
      createdBy: { columns: { id: true, name: true } },
      lastModifiedBy: { columns: { id: true, name: true } },
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    scope: row.scope,
    path: row.path,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: {
      userId: row.createdByUserId,
      name: row.createdBy?.name ?? null,
      actor: row.createdByActor,
      conversationId: row.createdByConversationId,
    },
    lastModifiedBy: {
      userId: row.lastModifiedByUserId,
      name: row.lastModifiedBy?.name ?? null,
      actor: row.lastModifiedByActor,
      conversationId: row.lastModifiedByConversationId,
    },
    content: row.content,
  };
};

/**
 * Convenience wrapper around `getMemoryContent` that throws 404 if the
 * row is missing — so handlers can `await` and reuse the result without
 * a second null check.
 */
export const requireMemoryContent = async (args: {
  id: string;
  organizationId: string;
  teamId: string;
  currentUserId: string;
}): Promise<MemoryContent> => {
  const row = await getMemoryContent(args);
  if (!row) {
    return throwHttpError(
      404,
      createApiError("MEMORY_FILE_NOT_FOUND", "Memory file not found"),
    );
  }
  return row;
};
