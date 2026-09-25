import { and, eq, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import {
  aiMemories,
  type AiMemory,
  type AiMemoryActor,
  type AiMemoryScope,
} from "../../db/schema/ai-memory";
import type { TeamMemoryScope } from "./types";

/**
 * Shape returned by the API for the settings list view. Reuses the
 * Zod-inferred `MemorySummaryResponse` field set, but kept as a hand-
 * written interface to avoid a circular `services → schemas → services`
 * import chain.
 */
export interface MemorySummary {
  id: string;
  scope: AiMemoryScope;
  path: string;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: {
    userId: string | null;
    name: string | null;
    actor: AiMemoryActor;
    conversationId: string | null;
  };
  lastModifiedBy: {
    userId: string | null;
    name: string | null;
    actor: AiMemoryActor;
    conversationId: string | null;
  };
}

/**
 * The people a summary names, by `name` only: surfacing emails in a shared
 * list would leak PII for users that have not opted in to public profile
 * sharing.
 */
export const MEMORY_SUMMARY_RELATIONS = {
  createdBy: { columns: { id: true, name: true } },
  lastModifiedBy: { columns: { id: true, name: true } },
} as const;

/** A note row as the summary reads it, with its two people loaded. */
export type MemorySummaryRow = Pick<
  AiMemory,
  | "id"
  | "scope"
  | "path"
  | "sizeBytes"
  | "createdAt"
  | "updatedAt"
  | "createdByUserId"
  | "createdByActor"
  | "createdByConversationId"
  | "lastModifiedByUserId"
  | "lastModifiedByActor"
  | "lastModifiedByConversationId"
> & {
  createdBy: { name: string } | null;
  lastModifiedBy: { name: string } | null;
};

export const toMemorySummary = (row: MemorySummaryRow): MemorySummary => ({
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
});

/**
 * Filter shape passed by the API handler. `scope` is optional —
 * omitting it returns the user/team merge (default for the legacy
 * untargeted call); the settings UI tabs always pass an explicit
 * scope so each tab paginates independently.
 */
export interface ListMemoriesForUiArgs {
  organizationId: string;
  teamId: string;
  currentUserId: string;
  scope?: TeamMemoryScope;
  limit: number;
  offset: number;
}

/**
 * List memory files visible to `currentUserId`, paginated.
 *
 *  - `scope='user'` returns only the caller's user-scope rows;
 *  - `scope='team'` returns the team-scope rows of the active team;
 *  - no scope returns the union of both (for callers that just want
 *    everything visible — e.g. an admin export).
 *
 * The Drizzle v2 query builder loads `createdBy` and `lastModifiedBy`
 * users via the relation aliases declared in `relations.ts`
 * (`MEMORY_SUMMARY_RELATIONS`). A project's notes never appear here: they
 * are listed from the project (`listProjectMemoriesForUi`).
 *
 * `total` is computed via a parallel `COUNT(*)` so the UI can render
 * page indicators without a second round-trip. The limit/offset are
 * applied to the rows query only.
 *
 * Sorted by `updatedAt DESC` so the most recently touched memories
 * appear first — matches user expectation in the settings UI.
 */
export const listMemoriesForUi = async (
  args: ListMemoriesForUiArgs,
): Promise<{ memories: MemorySummary[]; total: number }> => {
  // Three flat branches keep the v2 query-builder happy: a single
  // shorthand object per call so it can fully infer the result type
  // (including the `with: { createdBy, lastModifiedBy }` relations).
  // The CHECK constraint on the table guarantees `userId IS NULL` for
  // team rows, so filtering on `scope='team'` alone is sufficient.
  const findArgs = {
    with: MEMORY_SUMMARY_RELATIONS,
    orderBy: { updatedAt: "desc" },
    limit: args.limit,
    offset: args.offset,
  } as const;

  // Mirror predicate for the COUNT query — re-uses the SQL helpers
  // because `db.select(...)` does not accept the v2 object shorthand.
  const teamSql = and(eq(aiMemories.scope, "team"), isNull(aiMemories.userId));
  const userSql = and(
    eq(aiMemories.scope, "user"),
    eq(aiMemories.userId, args.currentUserId),
  );
  const scopeSql =
    args.scope === "team"
      ? teamSql
      : args.scope === "user"
        ? userSql
        : or(teamSql, userSql);

  const rowsPromise =
    args.scope === "team"
      ? db.query.aiMemories.findMany({
          where: {
            organizationId: args.organizationId,
            teamId: args.teamId,
            scope: "team",
          },
          ...findArgs,
        })
      : args.scope === "user"
        ? db.query.aiMemories.findMany({
            where: {
              organizationId: args.organizationId,
              teamId: args.teamId,
              scope: "user",
              userId: args.currentUserId,
            },
            ...findArgs,
          })
        : db.query.aiMemories.findMany({
            where: {
              organizationId: args.organizationId,
              teamId: args.teamId,
              OR: [
                { scope: "team" },
                { scope: "user", userId: args.currentUserId },
              ],
            },
            ...findArgs,
          });

  const [rows, totalRow] = await Promise.all([
    rowsPromise,
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.organizationId, args.organizationId),
          eq(aiMemories.teamId, args.teamId),
          scopeSql,
        ),
      ),
  ]);

  return {
    memories: rows.map(toMemorySummary),
    total: totalRow[0]?.count ?? 0,
  };
};

/**
 * A project's notes, paginated, newest first: what its people and the
 * assistant keep for it. The caller has decided the reader reaches the
 * project.
 */
export const listProjectMemoriesForUi = async (args: {
  organizationId: string;
  projectId: string;
  limit: number;
  offset: number;
}): Promise<{ memories: MemorySummary[]; total: number }> => {
  const [rows, totalRow] = await Promise.all([
    db.query.aiMemories.findMany({
      where: {
        organizationId: args.organizationId,
        scope: "project",
        projectId: args.projectId,
      },
      with: MEMORY_SUMMARY_RELATIONS,
      orderBy: { updatedAt: "desc" },
      limit: args.limit,
      offset: args.offset,
    }),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.organizationId, args.organizationId),
          eq(aiMemories.scope, "project"),
          eq(aiMemories.projectId, args.projectId),
        ),
      ),
  ]);
  return {
    memories: rows.map(toMemorySummary),
    total: totalRow[0]?.count ?? 0,
  };
};
