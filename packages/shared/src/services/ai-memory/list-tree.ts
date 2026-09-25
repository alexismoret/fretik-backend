import { and, asc, or } from "drizzle-orm";
import db from "../../db";
import { aiMemories, type AiMemoryScope } from "../../db/schema/ai-memory";
import { memoryNamespaceConditions } from "./lookup";
import type { MemoryScopeKey } from "./types";

/**
 * The memory tree as files, for the sandbox projection.
 *
 * Same visibility rule as `buildMemoryIndexManifest` — the namespaces the
 * turn reads (`memoryNamespacesFor`), each with its owner's rows — kept side
 * by side with it so the two views of one store can never disagree about what
 * a person may see.
 */

export interface MemoryTreeEntry {
  scope: AiMemoryScope;
  path: string;
  sizeBytes: number;
  updatedAt: Date;
}

/** The rows of these namespaces (never empty: the callers answer `[]` first). */
const visibleIn = (
  scopeKey: MemoryScopeKey,
  namespaces: readonly AiMemoryScope[],
) =>
  or(
    ...namespaces.map((scope) =>
      and(...memoryNamespaceConditions(scope, scopeKey)),
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
  namespaces: readonly AiMemoryScope[],
): Promise<MemoryTreeEntry[]> =>
  namespaces.length === 0
    ? []
    : db
        .select({
          scope: aiMemories.scope,
          path: aiMemories.path,
          sizeBytes: aiMemories.sizeBytes,
          updatedAt: aiMemories.updatedAt,
        })
        .from(aiMemories)
        .where(visibleIn(scopeKey, namespaces))
        .orderBy(asc(aiMemories.scope), asc(aiMemories.path));

/** The same rows WITH their bodies — read only when the fingerprint moved. */
export const listMemoryTreeWithContent = async (
  scopeKey: MemoryScopeKey,
  namespaces: readonly AiMemoryScope[],
): Promise<(MemoryTreeEntry & { content: string })[]> =>
  namespaces.length === 0
    ? []
    : db
        .select({
          scope: aiMemories.scope,
          path: aiMemories.path,
          sizeBytes: aiMemories.sizeBytes,
          updatedAt: aiMemories.updatedAt,
          content: aiMemories.content,
        })
        .from(aiMemories)
        .where(visibleIn(scopeKey, namespaces))
        .orderBy(asc(aiMemories.scope), asc(aiMemories.path));
