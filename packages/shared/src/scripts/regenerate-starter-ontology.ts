import { and, eq, inArray, isNull } from "drizzle-orm";
import db from "../db";
import {
  fieldDefinitions,
  objectTypes,
  organization,
  team,
} from "../db/schema";
import { invalidateFieldDefinitionsCache } from "../services/field-definitions/cache";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";
import { seedStarterObjectTypes } from "../services/object-types/seed-starter-types";
import { syncAllTypedViewsForTeam } from "../services/object-types/sync-typed-view";
import { STARTER_OBJECT_TYPE_TEMPLATE } from "../templates/object-types/starter";

/**
 * Regenerate the starter object types' FIELDS (company / person / note / task)
 * from the current template. The first seeding predates the new field types, so
 * existing orgs carry stale field definitions (e.g. `note.content` as plain text
 * instead of markdown, `task.status` without status groups, and no
 * `assignee` / `progress`).
 *
 * `seedStarterObjectTypes` is `onConflictDoNothing`, so it can only ADD new
 * fields — it cannot fix a field whose type/config changed. This script deletes
 * the starter types' field definitions (org template + every team copy) and
 * re-seeds them cleanly, then re-propagates to teams and rebuilds the typed
 * views. The object types themselves are KEPT (deleting them would cascade-delete
 * their records), and `object_records.data` is untouched — only the schema
 * (field definitions + views) is regenerated.
 *
 * Idempotent and safe to re-run.
 * Run: `bun --env-file=.env run src/scripts/regenerate-starter-ontology.ts`
 */
const STARTER_KEYS = STARTER_OBJECT_TYPE_TEMPLATE.types.map((t) => t.key);

const printStarterFields = async (
  organizationId: string,
  label: string,
): Promise<void> => {
  const types = await db
    .select({ id: objectTypes.id, key: objectTypes.key })
    .from(objectTypes)
    .where(
      and(
        eq(objectTypes.organizationId, organizationId),
        isNull(objectTypes.teamId),
        inArray(objectTypes.key, STARTER_KEYS),
      ),
    );
  const ids = types.map((t) => t.id);
  if (ids.length === 0) {
    console.log(`  (${label}) no starter types`);
    return;
  }
  const defs = await db
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        inArray(fieldDefinitions.objectTypeId, ids),
        isNull(fieldDefinitions.teamId),
      ),
    );
  console.log(`  (${label}) org-scope starter fields:`);
  for (const t of types) {
    const fields = defs.filter((d) => d.objectTypeId === t.id);
    for (const d of fields) {
      console.log(
        `      ${t.key}.${d.key} : ${d.type}  cfg=${JSON.stringify(d.config)}`,
      );
    }
  }
};

const run = async (): Promise<void> => {
  const orgs = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization);
  console.log(`Regenerating starter ontology for ${orgs.length} org(s)…`);

  for (const org of orgs) {
    console.log(`\n=== Org ${org.name} (${org.id}) ===`);
    await printStarterFields(org.id, "before");

    // 1. Resolve the starter object-type ids (org scope, kept — not deleted).
    const types = await db
      .select({ id: objectTypes.id })
      .from(objectTypes)
      .where(
        and(
          eq(objectTypes.organizationId, org.id),
          isNull(objectTypes.teamId),
          inArray(objectTypes.key, STARTER_KEYS),
        ),
      );
    const typeIds = types.map((t) => t.id);

    // 2. Delete the starter field definitions — BOTH the org template
    //    (teamId NULL) and every team copy (they reference the same type ids).
    if (typeIds.length > 0) {
      const deleted = await db
        .delete(fieldDefinitions)
        .where(inArray(fieldDefinitions.objectTypeId, typeIds))
        .returning({ id: fieldDefinitions.id });
      console.log(`  deleted ${deleted.length} stale field definition(s)`);
    }

    // 3. Re-seed the org-scope starter fields fresh (types already exist).
    await seedStarterObjectTypes(org.id);

    // 4. Re-propagate to every team + rebuild that team's typed views so the
    //    AI query surface reflects the new column types.
    const teams = await db
      .select({ id: team.id })
      .from(team)
      .where(eq(team.organizationId, org.id));
    for (const t of teams) {
      await duplicateOrgDefsToTeam({ organizationId: org.id, teamId: t.id });
      const viewCount = await syncAllTypedViewsForTeam({
        organizationId: org.id,
        teamId: t.id,
      });
      console.log(
        `  team ${t.id.slice(0, 8)}: rebuilt ${viewCount} typed view(s)`,
      );
    }

    await invalidateFieldDefinitionsCache({
      organizationId: org.id,
      teamId: null,
    });
    await printStarterFields(org.id, "after");
  }

  console.log("\n[regenerate] done");
  process.exit(0);
};

run().catch((error) => {
  console.error("[regenerate] failed:", error);
  process.exit(1);
});
