import { eq } from "drizzle-orm";
import db from "../../db";
import { teamMemoryDigests } from "../../db/schema";
import type { TeamMemoryDigest } from "../../db/schema/team-memory-digest";

/**
 * The digest for a team, or `null` if it has never been built.
 *
 * One primary-key lookup and nothing else — no join, no ordering, no filter
 * beyond the key. That is the entire reason the table is shaped the way it is:
 * this runs before every answer, so anything that turns it into a scan turns
 * the digest from an optimisation into a tax.
 *
 * Returns the row rather than the string because the caller needs `staleAt`
 * (serving an old digest is fine, pretending it is fresh is not) and `sources`
 * (to suppress the same rows from the retrieved block).
 */
export const readTeamDigest = async (
  teamId: string,
): Promise<TeamMemoryDigest | null> => {
  const [row] = await db
    .select()
    .from(teamMemoryDigests)
    .where(eq(teamMemoryDigests.teamId, teamId))
    .limit(1);
  return row ?? null;
};
