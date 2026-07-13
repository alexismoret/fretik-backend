import { and, eq, isNull, sql } from "drizzle-orm";
import db from "../db";
import { objectTypes } from "../db/schema";
import { qualifiedObjectTable } from "../services/object-schema/identifiers";
import { deleteObjectType } from "../services/object-types/delete";

/**
 * One-off cleanup: the `person` starter type is no longer seeded for new
 * orgs (removed from `STARTER_OBJECT_TYPE_TEMPLATE` — a generic workspace
 * shouldn't force it). Existing orgs still have the one seeded by
 * `seedStarterObjectTypes` before this change; this deletes it — but ONLY
 * where it holds zero records, since `deleteObjectType` cascades to records,
 * field definitions, and link types with no undo. Orgs where a team actually
 * used it are left untouched and logged for a manual decision.
 *
 * Idempotent (targets org-scope `key = "person"`, already-deleted orgs have
 * no matching row on a re-run).
 *
 * Run: `bun --env-file=../../.env run src/scripts/drop-empty-starter-person-type.ts`
 */
const run = async (): Promise<void> => {
  const rows = await db
    .select({
      id: objectTypes.id,
      organizationId: objectTypes.organizationId,
    })
    .from(objectTypes)
    .where(and(eq(objectTypes.key, "person"), isNull(objectTypes.teamId)));

  let dropped = 0;
  let skipped = 0;
  for (const row of rows) {
    const count = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ${sql.raw(qualifiedObjectTable(row.id))}`,
    );
    const recordCount = Number.parseInt(count.rows[0]?.count ?? "0", 10);
    if (recordCount > 0) {
      console.warn(
        `[drop-person] org ${row.organizationId}: ${recordCount.toString()} record(s) in "person" — skipped, needs a manual decision`,
      );
      skipped++;
      continue;
    }
    await deleteObjectType({ id: row.id });
    console.log(`[drop-person] org ${row.organizationId}: dropped (0 records)`);
    dropped++;
  }

  console.log(
    `[drop-person] done — dropped ${dropped.toString()}, skipped ${skipped.toString()} (had data)`,
  );
  process.exit(0);
};

run().catch((error) => {
  console.error("[drop-person] failed:", error);
  process.exit(1);
});
