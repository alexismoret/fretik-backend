import { eq, inArray } from "drizzle-orm";
import db from "../../db";
import type { AiEpisode } from "../../db/schema";
import { aiEpisodes } from "../../db/schema";
import { emitDomainEvent, SYSTEM_ACTOR } from "../domain-events/emit";

/**
 * Reverse one consolidation — the inverse `supersedeEpisodes` never had.
 * The other autonomous memory writers are reversible (`invalidateLink`,
 * `deleteMemory`); until this, a wrong MERGE removed its members from the
 * active set with no recourse short of manual SQL.
 *
 * Non-destructive both ways: members go back to `active` (pointer cleared),
 * the survivor is retired to `superseded` — pointing at nothing, since
 * nothing replaced it. Vector rows are NOT touched here: embedding needs the
 * AI service, so the caller owns the index swap (drop the survivor's vectors,
 * re-embed the members — theirs were deleted at consolidation time).
 */
export interface UnsupersedeEpisodesResult {
  survivor: AiEpisode;
  restored: AiEpisode[];
}

export const unsupersedeEpisodes = async (input: {
  survivorEpisodeId: string;
  teamId: string;
  organizationId: string;
}): Promise<UnsupersedeEpisodesResult | null> => {
  return db.transaction(async (tx) => {
    const survivor = await tx.query.aiEpisodes.findFirst({
      where: { id: input.survivorEpisodeId, teamId: input.teamId },
    });
    if (!survivor) return null;
    const members = await tx.query.aiEpisodes.findMany({
      where: {
        teamId: input.teamId,
        state: "superseded",
        supersededById: survivor.id,
      },
    });
    if (members.length === 0) return null;

    const restored = await tx
      .update(aiEpisodes)
      .set({ state: "active", supersededById: null })
      .where(
        inArray(
          aiEpisodes.id,
          members.map((m) => m.id),
        ),
      )
      .returning();
    const [retired] = await tx
      .update(aiEpisodes)
      .set({ state: "superseded" })
      .where(eq(aiEpisodes.id, survivor.id))
      .returning();
    if (!retired) return null;

    await emitDomainEvent({
      tx,
      organizationId: input.organizationId,
      teamId: input.teamId,
      type: "episode.unsuperseded",
      actor: SYSTEM_ACTOR,
      subjectType: "episode",
      payload: {
        episodeId: survivor.id,
        restoredIds: restored.map((e) => e.id),
        title: survivor.title,
      },
      dedupKey: `episode.unsuperseded:${survivor.id}`,
    });
    return { survivor: retired, restored };
  });
};
