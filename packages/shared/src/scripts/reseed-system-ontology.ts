import { eq, sql } from "drizzle-orm";
import db from "../db";
import { collections, organization, team } from "../db/schema";
import { assertOperatorTarget } from "../lib/operator-guard";
import {
  collectionTableName,
  qualifiedCollectionTable,
} from "../services/collection-schema/identifiers";
import { DOCUMENT_COLLECTION_KEY } from "../services/collections/constants";
import { seedStarterCollections } from "../services/collections/seed-starter-types";
import { seedSystemOntology } from "../services/collections/seed-system-types";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";

/**
 * Idempotent maintenance script: seed the standard collections (+ default
 * fields) for every organization, propagate org-scope field definitions to every
 * existing team (materialising their per-type tables), and backfill the document
 * `name` title from each file's label. Safe to re-run. Used to bring existing
 * orgs onto the dynamic-data system; usable by ops after a schema change to the
 * seeded set.
 *
 * Run: `bun --env-file=../../.env run src/scripts/reseed-system-ontology.ts`
 */

/**
 * Backfill the document `name` title (defaults to the filename) for records
 * created before the field was seeded — one UPDATE per `document_record` table,
 * reading each record's stored `_label`. Never overwrites a name a user set.
 */
const backfillDocumentNames = async (): Promise<void> => {
  const docTypes = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.key, DOCUMENT_COLLECTION_KEY));

  let totalRows = 0;
  for (const dt of docTypes) {
    const hasColumn = await db.execute<{ present: boolean }>(
      sql`SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'data'
              AND table_name = ${collectionTableName(dt.id)}
              AND column_name = 'name'
          ) AS present`,
    );
    if (hasColumn.rows[0]?.present !== true) continue;

    const res = await db.execute(
      sql`UPDATE ${sql.raw(qualifiedCollectionTable(dt.id))}
          SET "name" = "_label"
          WHERE ("name" IS NULL OR "name" = '')
            AND "_label" IS NOT NULL
            AND "_label" <> ''`,
    );
    totalRows += res.rowCount ?? 0;
  }
  console.log(`[reseed] backfilled ${totalRows.toString()} document name(s)`);
};

const run = async (): Promise<void> => {
  await assertOperatorTarget(Bun.argv);

  const orgs = await db.select({ id: organization.id }).from(organization);
  for (const org of orgs) {
    await seedSystemOntology(org.id);
    await seedStarterCollections(org.id);
    console.log(
      `[reseed] seeded system + starter collections for org ${org.id}`,
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

  await backfillDocumentNames();

  console.log("[reseed] done");
  process.exit(0);
};

run().catch((error) => {
  console.error("[reseed] failed:", error);
  process.exit(1);
});
