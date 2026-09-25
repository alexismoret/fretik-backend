import { and, eq, isNull, type SQL } from "drizzle-orm";
import db from "../../db";
import {
  aiMemories,
  type AiMemory,
  type AiMemoryScope,
} from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import type { MemoryScopeKey } from "./types";

/**
 * The project `/memories/project/` names for this key: the chat's. Outside
 * a project's chat it names nothing, and a note there is refused rather than
 * written somewhere nobody would look.
 */
export const projectOfKey = (key: MemoryScopeKey): string =>
  key.projectId ??
  throwHttpError(
    400,
    createApiError(
      "MEMORY_NO_PROJECT",
      "Project notes live in a project's chats: /memories/project/ names no project here.",
    ),
  );

/**
 * Who owns a note of this scope, as its row stores it: the writer for a
 * personal note, the chat's project for a project's, nobody for the team's
 * (the CHECK on `ai_memories` holds the same rule).
 */
export const memoryOwnerColumns = (
  scope: AiMemoryScope,
  key: MemoryScopeKey,
): { userId: string | null; projectId: string | null } => {
  if (scope === "user") return { userId: key.userId, projectId: null };
  if (scope === "team") return { userId: null, projectId: null };
  return { userId: null, projectId: projectOfKey(key) };
};

/**
 * Translate a (scope, scopeKey, relativePath) tuple to the WHERE
 * clause that hits exactly one of the partial unique indexes:
 *
 *  - `ai_memories_user_path_uq` for `scope='user'` (teamId, userId, path)
 *  - `ai_memories_team_path_uq` for `scope='team'` (teamId, path)
 *  - `ai_memories_project_path_uq` for `scope='project'` (projectId, path)
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
  const row = await db.query.aiMemories.findFirst({
    where: {
      organizationId: scopeKey.organizationId,
      path: relativePath,
      ...(scope === "user"
        ? { teamId: scopeKey.teamId, scope: "user", userId: scopeKey.userId }
        : scope === "team"
          ? { teamId: scopeKey.teamId, scope: "team" }
          : { scope: "project", projectId: projectOfKey(scopeKey) }),
    },
  });
  return row ?? null;
};

/**
 * The rows of one namespace, whatever their path: a person's notes in the
 * team, the team's, or the chat's project's.
 */
export const memoryNamespaceConditions = (
  scope: AiMemoryScope,
  key: MemoryScopeKey,
): SQL[] => {
  const inOrganization = eq(aiMemories.organizationId, key.organizationId);
  if (scope === "user") {
    return [
      inOrganization,
      eq(aiMemories.teamId, key.teamId),
      eq(aiMemories.scope, "user"),
      eq(aiMemories.userId, key.userId),
    ];
  }
  if (scope === "team") {
    return [
      inOrganization,
      eq(aiMemories.teamId, key.teamId),
      eq(aiMemories.scope, "team"),
      isNull(aiMemories.userId),
    ];
  }
  return [
    inOrganization,
    eq(aiMemories.scope, "project"),
    eq(aiMemories.projectId, projectOfKey(key)),
  ];
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
}) =>
  and(
    ...memoryNamespaceConditions(args.scope, args.scopeKey),
    eq(aiMemories.path, args.relativePath),
  );
