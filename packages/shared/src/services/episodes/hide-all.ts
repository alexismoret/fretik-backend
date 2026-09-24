import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";
import { forbidden, throwHttpError } from "../../lib/errors";
import { deleteEpisodeVectors } from "./vectors";

/**
 * Bulk "reset" of episodic memory — flip every ACTIVE episode in scope to
 * `demoted` and drop their recall vectors (the 30-day purge finalizes it).
 *   - `scope='user'` clears the caller's own private episodes.
 *   - `scope='team'` (`team.memory.manage`, decided by the caller) clears the
 *     episodes the whole team sees. Members' private episodes stay: a lead
 *     runs the team's shared memory, not what each person keeps for
 *     themselves, and every member can reset their own.
 * Set-based UPDATE; no per-row journal (a full wipe isn't worth the churn).
 */
export const hideAllEpisodes = async (input: {
  teamId: string;
  userId: string;
  scope: "user" | "team";
  canManageTeamMemory: boolean;
}): Promise<{ hidden: number }> => {
  if (input.scope === "team" && !input.canManageTeamMemory) {
    return throwHttpError(
      403,
      forbidden("Only a team lead can delete team memory"),
    );
  }

  const conditions = [
    eq(aiEpisodes.teamId, input.teamId),
    eq(aiEpisodes.state, "active"),
  ];
  conditions.push(
    input.scope === "user"
      ? eq(aiEpisodes.userId, input.userId)
      : isNull(aiEpisodes.userId),
  );

  const rows = await db
    .update(aiEpisodes)
    .set({ state: "demoted", demotedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: aiEpisodes.id });

  const ids = rows.map((r) => r.id);
  await deleteEpisodeVectors(ids);
  return { hidden: ids.length };
};
