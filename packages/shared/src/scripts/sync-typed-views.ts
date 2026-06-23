import db from "../db";
import { team } from "../db/schema";
import {
  syncAllTypedViewsForTeam,
  syncRecordView,
} from "../services/object-types/sync-typed-view";

/**
 * Idempotent maintenance script: (re)build the AI query path's typed views —
 * the global generic `v_record` plus one `v_<key>_<teamhex>` per (team, object
 * type) — for every team, using each team's current field definitions. Re-GRANTs
 * each view to `fretik_sql_tool` and refreshes the hot-field expression indexes.
 *
 * Used once to bring existing dev orgs onto the Phase 3 query path (the views
 * don't exist until a catalog change or team creation triggers them), and by
 * ops after bulk catalog edits. New orgs/teams get their views automatically at
 * type/field/team creation, so this is only for backfill/repair.
 *
 * Run: `bun --env-file=../../.env run src/scripts/sync-typed-views.ts`
 */
const run = async (): Promise<void> => {
  await syncRecordView();
  console.log("[sync-views] v_record ready");

  const teams = await db
    .select({ id: team.id, organizationId: team.organizationId })
    .from(team);
  for (const t of teams) {
    const count = await syncAllTypedViewsForTeam({
      organizationId: t.organizationId,
      teamId: t.id,
    });
    console.log(`[sync-views] team ${t.id}: ${count.toString()} typed views`);
  }

  console.log(`[sync-views] done (${teams.length.toString()} teams)`);
  process.exit(0);
};

run().catch((error) => {
  console.error("[sync-views] failed:", error);
  process.exit(1);
});
