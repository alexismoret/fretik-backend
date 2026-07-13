import { and, desc, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import type { AiEpisode, AiEpisodeKind, AiEpisodeState } from "../../db/schema";
import { aiEpisodes } from "../../db/schema";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Team-scoped episode listing for the settings UI. Privacy: a caller sees
 * the team's shared episodes (userId NULL) plus their OWN private ones —
 * never another member's.
 */
export const listEpisodes = async (input: {
  teamId: string;
  userId: string;
  kind?: AiEpisodeKind;
  state?: AiEpisodeState;
  limit?: number;
  offset?: number;
}): Promise<{ episodes: AiEpisode[] }> => {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const episodes = await db
    .select()
    .from(aiEpisodes)
    .where(
      and(
        eq(aiEpisodes.teamId, input.teamId),
        or(isNull(aiEpisodes.userId), eq(aiEpisodes.userId, input.userId)),
        ...(input.kind ? [eq(aiEpisodes.kind, input.kind)] : []),
        ...(input.state ? [eq(aiEpisodes.state, input.state)] : []),
      ),
    )
    .orderBy(desc(aiEpisodes.updatedAt))
    .limit(limit)
    .offset(input.offset ?? 0);
  return { episodes };
};

/** One episode with its anchored records (detail modal). Same privacy rule. */
export const getEpisode = async (input: {
  episodeId: string;
  teamId: string;
  userId: string;
}) =>
  db.query.aiEpisodes.findFirst({
    where: {
      id: input.episodeId,
      teamId: input.teamId,
      OR: [{ userId: { isNull: true } }, { userId: input.userId }],
    },
    with: {
      episodeRecords: {
        with: {
          record: { with: { objectType: { columns: { key: true } } } },
        },
      },
      conversation: true,
    },
  });
