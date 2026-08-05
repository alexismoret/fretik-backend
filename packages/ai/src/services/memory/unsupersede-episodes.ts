import type { EpisodeVectorMetadata } from "@fretik/shared/db/schema";
import { unsupersedeEpisodes } from "@fretik/shared/services/episodes/unsupersede";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";
import { vectorizeSource } from "../vectorize";

/**
 * Undo one consolidation end to end: restore the member rows (shared side),
 * then swap the recall index — the survivor's vectors drop, every restored
 * member is re-embedded (consolidation deleted theirs). The exact mirror of
 * `consolidate-episodes.ts`'s forward path.
 */
export interface UnsupersedeConsolidationResult {
  restored: number;
}

export const unsupersedeConsolidation = async (input: {
  survivorEpisodeId: string;
  teamId: string;
  organizationId: string;
}): Promise<UnsupersedeConsolidationResult | null> => {
  const result = await unsupersedeEpisodes(input);
  if (!result) return null;

  await deleteEpisodeVectors([result.survivor.id]);
  for (const ep of result.restored) {
    const metadata: EpisodeVectorMetadata = {
      kind: ep.kind,
      title: ep.title,
      conversation_id: ep.conversationId,
      anchor_record_id: ep.anchorRecordId,
      occurred_from: ep.occurredFrom?.toISOString() ?? null,
      occurred_to: ep.occurredTo?.toISOString() ?? null,
    };
    await vectorizeSource({
      sourceType: "episodes",
      sourceId: ep.id,
      content: `${ep.title}\n\n${ep.summary}`,
      metadata,
      teamId: input.teamId,
      organizationId: input.organizationId,
      userId: ep.userId,
    });
  }
  return { restored: result.restored.length };
};
