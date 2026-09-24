import db from "../../db";
import { createApiError, throwHttpError } from "../../lib/errors";
import {
  MEMORY_SUMMARY_RELATIONS,
  type MemorySummary,
  type MemorySummaryRow,
  toMemorySummary,
} from "./list-for-ui";

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
    with: MEMORY_SUMMARY_RELATIONS,
  });
  return row ? toMemoryContent(row) : null;
};

const toMemoryContent = (
  row: MemorySummaryRow & { content: string },
): MemoryContent => ({ ...toMemorySummary(row), content: row.content });

const memoryNotFound = (): never =>
  throwHttpError(
    404,
    createApiError("MEMORY_FILE_NOT_FOUND", "Memory file not found"),
  );

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
  return row ?? memoryNotFound();
};

/**
 * One of a project's notes, for someone the caller has decided reaches the
 * project. `null` when the id is not one of the project's notes, whatever
 * else it is.
 */
export const getProjectMemoryContent = async (args: {
  id: string;
  organizationId: string;
  projectId: string;
}): Promise<MemoryContent | null> => {
  const row = await db.query.aiMemories.findFirst({
    where: {
      id: args.id,
      organizationId: args.organizationId,
      scope: "project",
      projectId: args.projectId,
    },
    with: MEMORY_SUMMARY_RELATIONS,
  });
  return row ? toMemoryContent(row) : null;
};

/** `getProjectMemoryContent`, 404 when the note is not the project's. */
export const requireProjectMemoryContent = async (args: {
  id: string;
  organizationId: string;
  projectId: string;
}): Promise<MemoryContent> =>
  (await getProjectMemoryContent(args)) ?? memoryNotFound();
