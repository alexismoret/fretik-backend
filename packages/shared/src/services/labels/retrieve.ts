import db from "../../db";
import { selectOrCache } from "../../lib/redis";

/**
 * List every label owned by a team, sorted alphabetically.
 * Used by both the drive filter (frontend) and the chatbot's
 * `listLabels` tool (which calls into Drizzle directly for now —
 * see `@fretik/ai/src/tools/list-labels.ts`).
 *
 * Pagination + case-insensitive name search are supported so the
 * frontend can power the label filter / picker without dumping every
 * row in one shot.
 *
 * Cache strategy : the no-search path (most common — filter dropdown
 * pre-populates with all labels) caches under
 * `team:{teamId}:labels:list:{limit}:{offset}` (10-min TTL). The search
 * path skips cache entirely — many possible inputs, low cache hit rate.
 * Future label-mutation flows must call
 * `deleteKeysByPrefix('team:{teamId}:labels:')` after commit.
 */
export const listTeamLabels = async (data: {
  teamId: string;
  search?: string;
  limit: number;
  offset: number;
}) => {
  const { teamId, search, limit, offset } = data;

  const query = () =>
    db.query.labels.findMany({
      columns: { id: true, name: true, color: true },
      where: {
        teamId,
        ...(search && search.length > 0
          ? { name: { ilike: `%${search}%` } }
          : {}),
      },
      orderBy: { name: "asc" },
      limit,
      offset,
    });

  if (search && search.length > 0) {
    return await query();
  }
  return await selectOrCache(
    query,
    `team:${teamId}:labels:list:${limit}:${offset}`,
    10 * 60,
  );
};
