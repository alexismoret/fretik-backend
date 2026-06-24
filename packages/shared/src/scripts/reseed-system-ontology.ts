import db from "../db";
import { organization, team } from "../db/schema";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";
import { seedStarterObjectTypes } from "../services/object-types/seed-starter-types";
import { seedSystemOntology } from "../services/object-types/seed-system-types";

/**
 * Idempotent maintenance script: seed the standard object types (+ default
 * fields) for every organization, and propagate org-scope field definitions to
 * every existing team. Safe to re-run. Used once to bring dev orgs onto the
 * dynamic-data system; usable by ops after a schema change to the seeded set.
 *
 * Run: `bun --env-file=../../.env run src/scripts/reseed-system-ontology.ts`
 */
const run = async (): Promise<void> => {
  const orgs = await db.select({ id: organization.id }).from(organization);
  for (const org of orgs) {
    await seedSystemOntology(org.id);
    await seedStarterObjectTypes(org.id);
    console.log(
      `[reseed] seeded system + starter object types for org ${org.id}`,
    );
  }

  const teams = await db
    .select({ id: team.id, organizationId: team.organizationId })
    .from(team);
  for (const t of teams) {
    const { inserted } = await duplicateOrgDefsToTeam({
      organizationId: t.organizationId,
      teamId: t.id,
    });
    console.log(`[reseed] +${inserted} field defs propagated to team ${t.id}`);
  }

  console.log("[reseed] done");
  process.exit(0);
};

run().catch((error) => {
  console.error("[reseed] failed:", error);
  process.exit(1);
});
