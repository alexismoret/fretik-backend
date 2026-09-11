import db from "@fretik/shared/db";
import { team, teamMember } from "@fretik/shared/db/schema";
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { bootstrapTeamWithBotUser } from "@fretik/shared/services/auth/bot-user";
import { and, eq } from "drizzle-orm";

/**
 * Provision the team the WRITE-side eval suites own.
 *
 * Why a second team. `evals:memory` and `evals:chain` do not read a corpus,
 * they WRITE one — episodes, consolidations, `learned/` memories — and they
 * write it into whatever team they are pointed at. Until 2026-09-11 that was
 * `EVAL_TEAM_ID`, the same team the read-side suites score against, which is
 * also a team somebody actually works in. Two measured consequences:
 *
 *   - `evals:memory` leaves `learned/meridian-bon-de-commande.md` behind, and
 *     `promoteEpisodes` loads EVERY `learned/%` row of the team into its
 *     `<existing_learned>` block. Its prompt says "NOOP: … or already
 *     covered", so a leftover about signed purchase orders is a correct reason
 *     for the promoter to decline the chain suite's signed-purchase-order
 *     convention. `chain-convention-promoted` went 10/10 -> 0/10.
 *   - `evals:chain` rewrote the shared team's single `team_memory_digests` row
 *     per repeat, putting its fixtures into the standing prompt of every other
 *     e2e suite — and of every human turn in that team.
 *
 * Isolation by cleanup was the old answer and it is the wrong shape: it makes
 * correctness depend on remembering a flag. Separate teams make the suites
 * unable to reach each other.
 *
 * Idempotent by team NAME, so re-running prints the same id.
 *
 *   bun run evals:ensure-write-team
 */

const WRITE_TEAM_NAME = "eval-write";

const organizationId = process.env.EVAL_ORGANIZATION_ID ?? "";
const userId = process.env.EVAL_USER_ID ?? "";

if (!organizationId || !userId) {
  console.error(
    "Missing EVAL_ORGANIZATION_ID / EVAL_USER_ID — the write team lives in the same org as the read team, with the same member.",
  );
  process.exit(1);
}

await assertOperatorTarget(Bun.argv);

/**
 * Better Auth 1.7's single-column uniqueness boundary for a user in a team.
 * Recomputed here for the same reason `bot-user.ts` recomputes it: the row is
 * inserted directly rather than through `addTeamMember`, and a NULL key would
 * leave that boundary unenforced for exactly the row we control.
 */
const membershipKey = async (
  teamId: string,
  memberId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, memberId])),
  );
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const existing = await db.query.team.findFirst({
  where: { organizationId, name: WRITE_TEAM_NAME },
  columns: { id: true },
});

const teamId = await (async (): Promise<string> => {
  if (existing) return existing.id;
  const [row] = await db
    .insert(team)
    .values({ name: WRITE_TEAM_NAME, organizationId, createdAt: new Date() })
    .returning({ id: team.id });
  if (!row) throw new Error("failed to insert the eval write team");
  return row.id;
})();

// The eval user must be a member: recall's privacy predicate is
// `user_id IS NULL OR user_id = :caller`, and the write suites run as this
// user. A non-member would score every private-scope assertion against rows it
// cannot see.
const alreadyMember = await db.query.teamMember.findFirst({
  where: { teamId, userId },
  columns: { id: true },
});
if (!alreadyMember) {
  await db
    .insert(teamMember)
    .values({
      teamId,
      userId,
      membershipKey: await membershipKey(teamId, userId),
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  await db
    .update(team)
    .set({ memberCount: 1 })
    .where(and(eq(team.id, teamId), eq(team.organizationId, organizationId)));
}

// `promoteEpisodes` attributes a team-scope write to the team's bot user and
// THROWS when the settings row is missing, so this is not optional decoration.
const botUserId = await bootstrapTeamWithBotUser({ teamId, organizationId });

console.info(
  `[eval-write-team] ${existing ? "found" : "created"} "${WRITE_TEAM_NAME}"\n` +
    `  EVAL_WRITE_TEAM_ID=${teamId}\n` +
    `  bot user: ${botUserId}\n` +
    (existing
      ? ""
      : "\nAdd the line above to backend/packages/ai/.env, then re-run the write suites.\n"),
);

process.exit(0);
