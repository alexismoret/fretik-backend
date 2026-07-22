import { and, eq } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";
import { forbidden, throwHttpError } from "../../lib/errors";
import { deleteEpisodeVectors } from "./vectors";

/**
 * Bulk "reset" of episodic memory — flip every ACTIVE episode in scope to
 * `demoted` and drop their recall vectors (the 30-day purge finalizes it).
 *   - `scope='user'` clears the caller's own private episodes.
 *   - `scope='team'` (admin only) clears the whole team's episodes, including
 *     every member's private ones.
 * Set-based UPDATE; no per-row journal (a full wipe isn't worth the churn).
 */
export const hideAllEpisodes = async (input: {
  teamId: string;
  userId: string;
  scope: "user" | "team";
  isAdmin: boolean;
}): Promise<{ hidden: number }> => {
  if (input.scope === "team" && !input.isAdmin) {
    return throwHttpError(
      403,
      forbidden("Only an admin can delete team memory"),
    );
  }

  const conditions = [
    eq(aiEpisodes.teamId, input.teamId),
    eq(aiEpisodes.state, "active"),
  ];
  if (input.scope === "user") {
    conditions.push(eq(aiEpisodes.userId, input.userId));
  }

  const rows = await db
    .update(aiEpisodes)
    .set({ state: "demoted", demotedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: aiEpisodes.id });

  const ids = rows.map((r) => r.id);
  void deleteEpisodeVectors(ids);
  return { hidden: ids.length };
};
