import { eq } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../lib/errors";
import { emitDomainEvent } from "../domain-events/emit";
import { deleteEpisodeVectors } from "./vectors";

/**
 * User-initiated episode delete = soft-hide. Flip an `active` episode to
 * `demoted` (+ `demotedAt`) and drop its recall vectors, so it leaves recall,
 * searchKnowledge, dreaming and the default settings view immediately. The
 * nightly GC's 30-day purge (`purgeExpiredEpisodes`) finalizes the hard
 * delete. Privacy mirrors `getEpisode`: a member may hide their OWN private
 * episode; a team-visible one (`userId IS NULL`) is shared memory — admin only.
 */
export const hideEpisode = async (input: {
  episodeId: string;
  teamId: string;
  userId: string;
  isAdmin: boolean;
}): Promise<void> => {
  const episode = await db.query.aiEpisodes.findFirst({
    columns: {
      id: true,
      organizationId: true,
      teamId: true,
      userId: true,
      state: true,
      title: true,
    },
    where: {
      id: input.episodeId,
      teamId: input.teamId,
      OR: [{ userId: { isNull: true } }, { userId: input.userId }],
    },
  });
  if (!episode) {
    return throwHttpError(404, notFound("Episode not found"));
  }
  if (episode.userId === null && !input.isAdmin) {
    return throwHttpError(
      403,
      forbidden("Only an admin can delete team memory"),
    );
  }

  // Only an active episode needs the flip + journal; a demoted/superseded one
  // is already out of recall, so we fall through to the idempotent vector drop.
  if (episode.state === "active") {
    await db.transaction(async (tx) => {
      await tx
        .update(aiEpisodes)
        .set({ state: "demoted", demotedAt: new Date() })
        .where(eq(aiEpisodes.id, episode.id));
      await emitDomainEvent({
        tx,
        organizationId: episode.organizationId,
        teamId: episode.teamId,
        type: "episode.deleted",
        actor: { actorType: "user", actorUserId: input.userId },
        subjectType: "episode",
        payload: { episodeId: episode.id, title: episode.title },
        dedupKey: `episode.deleted:${episode.id}`,
      });
    });
  }

  void deleteEpisodeVectors([episode.id]);
};
