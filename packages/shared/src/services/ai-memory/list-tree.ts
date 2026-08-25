import { and, asc, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import { aiMemories, type AiMemoryScope } from "../../db/schema/ai-memory";
import type { MemoryScopeKey } from "./types";

/**
 * The memory tree as files, for the sandbox projection.
 *
 * Same visibility rule as `buildMemoryIndexManifest` — the user's own private
 * memories plus the team's shared ones — kept side by side with it so the two
 * views of one store can never disagree about what a person may see.
 */

export interface MemoryTreeEntry {
  scope: AiMemoryScope;
  path: string;
  sizeBytes: number;
  updatedAt: Date;
}

const visibleTo = (scopeKey: MemoryScopeKey) =>
  and(
    eq(aiMemories.organizationId, scopeKey.organizationId),
    eq(aiMemories.teamId, scopeKey.teamId),
    or(
      and(eq(aiMemories.scope, "user"), eq(aiMemories.userId, scopeKey.userId)),
      and(eq(aiMemories.scope, "team"), isNull(aiMemories.userId)),
    ),
  );

/**
 * Everything needed to decide whether the projection is current — and nothing
 * else. No `content`, so this stays a two-column index read that runs on every
 * code call for the price of a sub-millisecond query.
 *
 * `updatedAt` is what makes the fingerprint self-correcting: every write the
 * `memory` tool performs moves it (or removes the row), so the agent writing a
 * memory mid-turn and then grepping for it just works, with no invalidation
 * hook to keep in sync. The database is the generation counter.
 */
export const listMemoryFingerprint = async (
  scopeKey: MemoryScopeKey,
): Promise<MemoryTreeEntry[]> =>
  db
    .select({
      scope: aiMemories.scope,
      path: aiMemories.path,
      sizeBytes: aiMemories.sizeBytes,
      updatedAt: aiMemories.updatedAt,
    })
    .from(aiMemories)
    .where(visibleTo(scopeKey))
    .orderBy(asc(aiMemories.scope), asc(aiMemories.path));

/** The same rows WITH their bodies — read only when the fingerprint moved. */
export const listMemoryTreeWithContent = async (
  scopeKey: MemoryScopeKey,
): Promise<(MemoryTreeEntry & { content: string })[]> =>
  db
    .select({
      scope: aiMemories.scope,
      path: aiMemories.path,
      sizeBytes: aiMemories.sizeBytes,
      updatedAt: aiMemories.updatedAt,
      content: aiMemories.content,
    })
    .from(aiMemories)
    .where(visibleTo(scopeKey))
    .orderBy(asc(aiMemories.scope), asc(aiMemories.path));
