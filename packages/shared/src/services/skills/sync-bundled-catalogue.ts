import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Client } from "pg";
import db from "../../db";
import { skills } from "../../db/schema";

/**
 * One on-disk bundled skill summary, as produced by the @fretik/ai
 * `loadSkillCatalog()` walker.
 *
 * `name` + `description` are the Anthropic-spec frontmatter fields
 * the catalogue tracks for every skill.
 *
 * `isDefault` + `isMeta` are optional Fretik-specific flags lifted
 * from `metadata.fretik_*` in the same frontmatter. They're honoured
 * ONLY when the row is first INSERTed — existing rows are never
 * overwritten so a manual flip via SQL or seed migration persists.
 */
export interface BundledCatalogueEntry {
  name: string;
  description: string;
  isDefault?: boolean;
  isMeta?: boolean;
}

export interface BundledCatalogueSyncResult {
  inserted: number;
  updated: number;
  softDeleted: number;
  restored: number;
}

/**
 * Lock id distinct from `MIGRATION_LOCK_ID` so the catalogue sync
 * doesn't block schema migrations and vice versa. Pinned constant —
 * the same value is used by every replica so the lock serialises
 * across boots cluster-wide.
 */
const CATALOGUE_SYNC_LOCK_ID = 4242424242424243n;

/**
 * Reconcile the `skills` table with the on-disk bundled catalogue.
 *
 *  - INSERT rows for skills that exist on disk but not in DB.
 *  - UPDATE descriptions that drift between disk and DB (single
 *    source of truth = the SKILL.md file). `is_default` and `version`
 *    are PRESERVED — they're Fretik-specific concepts not encoded in
 *    the frontmatter, so the manual seed migration's values stick.
 *  - RESTORE rows that were soft-deleted in a previous boot but are
 *    now back on disk (clear `deleted_at`, refresh description). This
 *    matches the "team override survives a rename round-trip" guarantee
 *    documented in the schema header.
 *  - SOFT-DELETE rows whose name is no longer on disk (set
 *    `deleted_at = now()`). The row stays so any historical
 *    `team_skills` override is preserved for nostalgia.
 *
 * Runs inside a Postgres advisory lock so concurrent replica boots
 * don't fight over the same INSERTs. Mirrors the pattern used by
 * `runMigrationsWithLock` — separate lock id so the two phases don't
 * deadlock if one happens to call the other.
 *
 * Returns a small counter envelope for boot logging. Throws on
 * connection / SQL errors so the caller decides whether to fail fast
 * (production boot) or warn and continue (dev hot-reload).
 */
export const syncBundledSkillsCatalogue = async (
  entries: BundledCatalogueEntry[],
): Promise<BundledCatalogueSyncResult> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing env var DATABASE_URL");
  }

  const lockClient = new Client({ connectionString: databaseUrl });
  await lockClient.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [
      CATALOGUE_SYNC_LOCK_ID,
    ]);

    const diskNames = entries.map((e) => e.name);
    const diskByName = new Map(entries.map((e) => [e.name, e]));

    // Read current bundled rows (deleted or not) so we can decide
    // INSERT vs UPDATE vs RESTORE vs SOFT-DELETE in a single pass.
    const dbRows = await db
      .select({
        id: skills.id,
        name: skills.name,
        description: skills.description,
        isDefault: skills.isDefault,
        isMeta: skills.isMeta,
        deletedAt: skills.deletedAt,
      })
      .from(skills)
      .where(and(eq(skills.source, "bundled"), isNull(skills.teamId)));

    const dbByName = new Map(dbRows.map((r) => [r.name, r]));

    let inserted = 0;
    let updated = 0;
    let restored = 0;

    for (const entry of entries) {
      const existing = dbByName.get(entry.name);
      if (!existing) {
        await db.insert(skills).values({
          name: entry.name,
          description: entry.description,
          source: "bundled",
          // teamId NULL by default (bundled scope).
          // isDefault / isMeta come from `metadata.fretik_*` in the
          // SKILL.md frontmatter — falls back to column defaults
          // (both false) when the SKILL.md doesn't declare them.
          // Core file-generation skills (docx/pdf/…) were seeded
          // is_default=true in the original migration and stay that
          // way because UPDATE never touches these columns.
          ...(entry.isDefault === undefined
            ? {}
            : { isDefault: entry.isDefault }),
          ...(entry.isMeta === undefined ? {} : { isMeta: entry.isMeta }),
        });
        inserted++;
        continue;
      }

      const needsRestore = existing.deletedAt !== null;
      const needsDescriptionUpdate = existing.description !== entry.description;
      // `metadata.fretik_*` flags propagate to UPDATE only when the
      // SKILL.md declares them — frontmatter is the source of truth
      // for skills that opt in. Rows whose SKILL.md doesn't declare
      // them keep whatever the seed migration set (e.g. docx/pdf/…
      // staying is_default=true even when reseeding the description).
      const needsDefaultUpdate =
        entry.isDefault !== undefined && existing.isDefault !== entry.isDefault;
      const needsMetaUpdate =
        entry.isMeta !== undefined && existing.isMeta !== entry.isMeta;

      if (
        needsRestore ||
        needsDescriptionUpdate ||
        needsDefaultUpdate ||
        needsMetaUpdate
      ) {
        await db
          .update(skills)
          .set({
            description: entry.description,
            deletedAt: null,
            ...(needsDefaultUpdate ? { isDefault: entry.isDefault } : {}),
            ...(needsMetaUpdate ? { isMeta: entry.isMeta } : {}),
          })
          .where(eq(skills.id, existing.id));
        if (needsRestore) restored++;
        else updated++;
      }
    }

    // Soft-delete anything in DB that's no longer on disk. We only
    // touch live rows (deleted_at IS NULL) so repeated boots don't
    // bump updated_at for already-buried rows.
    //
    // Safety net: a transient empty filesystem walk (e.g. wrong cwd,
    // mid-deploy state) would soft-delete every bundled row. Refuse
    // the prune in that case — the next healthy boot reconciles.
    let softDeleted = 0;
    const liveDbNames = dbRows
      .filter((r) => r.deletedAt === null)
      .map((r) => r.name);

    if (diskNames.length === 0 && liveDbNames.length > 0) {
      console.warn(
        "[skills-sync] disk catalogue empty — skipped soft-delete pass as a safety net",
      );
    } else {
      const orphanNames = liveDbNames.filter((n) => !diskByName.has(n));
      if (orphanNames.length > 0) {
        await db
          .update(skills)
          .set({ deletedAt: sql`now()` })
          .where(
            and(
              eq(skills.source, "bundled"),
              isNull(skills.teamId),
              isNull(skills.deletedAt),
              inArray(skills.name, orphanNames),
            ),
          );
        softDeleted = orphanNames.length;
      }
    }

    return { inserted, updated, softDeleted, restored };
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [
        CATALOGUE_SYNC_LOCK_ID,
      ]);
    } catch (err) {
      console.error(
        "[skills-sync] failed to release advisory lock:",
        err instanceof Error ? err.message : err,
      );
    }
    await lockClient.end();
  }
};
