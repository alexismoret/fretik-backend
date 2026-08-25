import { sql } from "drizzle-orm";
import db from "../db";

/**
 * Post-deploy data migration for the `objects` -> `collections` rename:
 * rewrite the `object_type_id` / `object_type_key` metadata keys of
 * `ai_vectors` to `collection_id` / `collection_key`.
 *
 * Split out of `20260825120000_rename_objects_to_collections` on purpose. Every
 * matching row carries an embedding, so the rewrite costs ~6KB/row — measured
 * at 77s for 20k rows, against ~2s for the whole rest of that migration.
 * Migrations run at container boot inside ONE transaction, so on a large table
 * that window outlives the orchestrator's health check: the container is killed,
 * the transaction rolls back, and the deploy restart-loops.
 *
 * Batched and committed per chunk, so it holds no long transaction and can run
 * while the app serves traffic. Idempotent and resumable: the guard only ever
 * matches un-migrated rows, so a re-run after an interruption picks up where it
 * stopped, and a run with nothing left to do is a no-op.
 *
 * Until this has run, `purgeCardVectorsForType` (which probes
 * `metadata @> {"collection_id": …}`) leaves orphan cards behind when a
 * collection is deleted. Retrieval does not read these keys.
 *
 * Run: `bun --env-file=.env run src/scripts/migrate-vector-metadata-keys.ts`
 */

const BATCH = 500;

const run = async (): Promise<void> => {
  const total = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ai_vectors
    WHERE metadata ?| array['object_type_id', 'object_type_key']`);
  const pending = total.rows[0]?.n ?? 0;
  console.log(`[vector-keys] ${pending.toString()} row(s) to migrate`);
  if (pending === 0) {
    console.log("[vector-keys] nothing to do");
    process.exit(0);
  }

  let done = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH batch AS (
        SELECT id FROM ai_vectors
        WHERE metadata ?| array['object_type_id', 'object_type_key']
        LIMIT ${BATCH}
      )
      UPDATE ai_vectors v
      SET metadata = (v.metadata - 'object_type_id' - 'object_type_key')
        || CASE WHEN v.metadata ? 'object_type_id'
                THEN jsonb_build_object('collection_id', v.metadata -> 'object_type_id')
                ELSE '{}'::jsonb END
        || CASE WHEN v.metadata ? 'object_type_key'
                THEN jsonb_build_object('collection_key', v.metadata -> 'object_type_key')
                ELSE '{}'::jsonb END
      FROM batch WHERE v.id = batch.id`);
    const n = res.rowCount ?? 0;
    if (n === 0) break;
    done += n;
    console.log(`[vector-keys] ${done.toString()}/${pending.toString()}`);
  }

  const left = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ai_vectors
    WHERE metadata ?| array['object_type_id', 'object_type_key']`);
  console.log(
    `[vector-keys] done — ${(left.rows[0]?.n ?? 0).toString()} row(s) left`,
  );
  process.exit(0);
};

run().catch((error: unknown) => {
  console.error("[vector-keys] failed:", error);
  process.exit(1);
});
