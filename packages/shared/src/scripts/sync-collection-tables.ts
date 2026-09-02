import db from "../db";
import { team } from "../db/schema";
import { assertOperatorTarget } from "../lib/operator-guard";
import { syncAllCollectionTablesForTeam } from "../services/collection-schema/catalog-sync";

/**
 * Idempotent maintenance script: reconcile every team's per-type extension
 * tables (`data.coll_<collectionId>`) against their current field definitions —
 * creating missing tables, adding/dropping columns, and (re)arming RLS. (No
 * views anywhere — the chatbot queries the real tables directly.)
 *
 * This is the EXISTING-TENANT provisioning/backfill primitive: bring orgs/teams
 * that pre-date the typed-table refonte onto the physical model, and repair
 * after bulk catalog edits. New orgs/teams get their tables automatically at
 * type/field/team creation (the DDL engine runs in those write paths), so this
 * is only for backfill/repair — see scripts/README.md.
 *
 * Run: `bun --env-file=../../.env run src/scripts/sync-collection-tables.ts`
 */
const run = async (): Promise<void> => {
  await assertOperatorTarget(Bun.argv);

  const teams = await db
    .select({ id: team.id, organizationId: team.organizationId })
    .from(team);
  for (const t of teams) {
    const count = await syncAllCollectionTablesForTeam({
      organizationId: t.organizationId,
      teamId: t.id,
    });
    console.log(
      `[sync-tables] team ${t.id}: ${count.toString()} collection table(s)`,
    );
  }

  console.log(`[sync-tables] done (${teams.length.toString()} teams)`);
  process.exit(0);
};

run().catch((error) => {
  console.error("[sync-tables] failed:", error);
  process.exit(1);
});
