import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";
import { deleteEpisodeVectors } from "./vectors";

/**
 * Hide the episodes distilled from a workflow's runs — used when a workflow is
 * archived (the user is done with it, so its run memory should stop surfacing
 * in recall). Workflow provenance has no FK; it lives in the episode's
 * `metadata` JSONB (`workflowId` / `workflowRunId`, set by the distiller), so
 * we match on `metadata->>'workflowId'`, scoped to the team. Flips `active →
 * demoted`, drops vectors, and lets the 30-day GC purge finalize it. Not in a
 * caller transaction (archive is a plain status update — no FK race), so it
 * manages its own vector cleanup.
 */
export const hideEpisodesForWorkflow = async (input: {
  teamId: string;
  workflowId: string;
}): Promise<{ hidden: number }> => {
  const rows = await db
    .update(aiEpisodes)
    .set({ state: "demoted", demotedAt: new Date() })
    .where(
      and(
        eq(aiEpisodes.teamId, input.teamId),
        eq(aiEpisodes.state, "active"),
        sql`${aiEpisodes.metadata} ->> 'workflowId' = ${input.workflowId}`,
      ),
    )
    .returning({ id: aiEpisodes.id });

  const ids = rows.map((r) => r.id);
  await deleteEpisodeVectors(ids);
  return { hidden: ids.length };
};
