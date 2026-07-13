import { eq } from "drizzle-orm";
import db from "../../db";
import { teamToolPolicies } from "../../db/schema";
import type { ToolPolicyLevel } from "../../schemas/tool-policies";
import { invalidateTeamToolPoliciesCache } from "./cache";

/**
 * Apply a SPARSE patch to a team's builtin-tool policy map. A level SETS the
 * override for that tool; `null` DELETES the key (resets it to the catalog
 * default); a tool absent from the patch is left untouched. Catalog +
 * selectable-level validation is the caller's job (the settings handler) — this
 * service only merges + persists + invalidates the cache.
 *
 * Read-modify-write inside a transaction (row-locked) so two concurrent admin
 * edits can't clobber each other. The row is created lazily on first write.
 */
export const upsertTeamToolPolicies = async (data: {
  teamId: string;
  patch: Record<string, ToolPolicyLevel | null>;
}): Promise<Record<string, ToolPolicyLevel>> => {
  const { teamId, patch } = data;

  const merged = await db.transaction(async (tx) => {
    // Ensure a row exists, then lock it for the read-modify-write.
    await tx
      .insert(teamToolPolicies)
      .values({ teamId, policies: {} })
      .onConflictDoNothing({ target: teamToolPolicies.teamId });

    const [row] = await tx
      .select({ policies: teamToolPolicies.policies })
      .from(teamToolPolicies)
      .where(eq(teamToolPolicies.teamId, teamId))
      .for("update");

    const next: Record<string, ToolPolicyLevel> = { ...(row?.policies ?? {}) };
    for (const [name, level] of Object.entries(patch)) {
      if (level === null) delete next[name];
      else next[name] = level;
    }

    await tx
      .update(teamToolPolicies)
      .set({ policies: next, updatedAt: new Date() })
      .where(eq(teamToolPolicies.teamId, teamId));

    return next;
  });

  await invalidateTeamToolPoliciesCache(teamId);
  return merged;
};
