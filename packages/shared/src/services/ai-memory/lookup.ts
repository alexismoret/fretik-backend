import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import {
  aiMemories,
  type AiMemory,
  type AiMemoryScope,
} from "../../db/schema/ai-memory";
import type { MemoryScopeKey } from "./types";

/**
 * Translate a (scope, scopeKey, relativePath) tuple to the WHERE
 * clause that hits exactly one of the partial unique indexes:
 *
 *  - `ai_memories_user_path_uq` for `scope='user'` (teamId, userId, path)
 *  - `ai_memories_team_path_uq` for `scope='team'` (teamId, path)
 *
 * Centralised so every service uses the same predicate — keeps the
 * scoping rule in one place.
 */
export const findMemoryByPath = async (args: {
  scope: AiMemoryScope;
  relativePath: string;
  scopeKey: MemoryScopeKey;
}): Promise<AiMemory | null> => {
  const { scope, relativePath, scopeKey } = args;
  if (scope === "user") {
    const row = await db.query.aiMemories.findFirst({
      where: {
        organizationId: scopeKey.organizationId,
        teamId: scopeKey.teamId,
        scope: "user",
        userId: scopeKey.userId,
        path: relativePath,
      },
    });
    return row ?? null;
  }
  const row = await db.query.aiMemories.findFirst({
    where: {
      organizationId: scopeKey.organizationId,
      teamId: scopeKey.teamId,
      scope: "team",
      path: relativePath,
    },
  });
  return row ?? null;
};

/**
 * SQL predicate variant — same lookup but returned as a Drizzle
 * `SQL` so it can be re-used in builder queries (e.g. UPDATE / DELETE
 * with the same WHERE clause).
 */
export const memoryScopePathPredicate = (args: {
  scope: AiMemoryScope;
  relativePath: string;
  scopeKey: MemoryScopeKey;
}) => {
  const { scope, relativePath, scopeKey } = args;
  if (scope === "user") {
    return and(
      eq(aiMemories.organizationId, scopeKey.organizationId),
      eq(aiMemories.teamId, scopeKey.teamId),
      eq(aiMemories.scope, "user"),
      eq(aiMemories.userId, scopeKey.userId),
      eq(aiMemories.path, relativePath),
    );
  }
  return and(
    eq(aiMemories.organizationId, scopeKey.organizationId),
    eq(aiMemories.teamId, scopeKey.teamId),
    eq(aiMemories.scope, "team"),
    isNull(aiMemories.userId),
    eq(aiMemories.path, relativePath),
  );
};
