ALTER TABLE "collection_sync_runs" ADD COLUMN "unmatched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "match_field_key" varchar(120);--> statement-breakpoint
-- HAND-EDITED. drizzle-kit 1.0.0-rc.4 has no `RENAME VALUE` emitter, so it
-- generated the only enum change it knows: cast the column to text, drop the
-- type, recreate it with the new values, cast back. That sequence FAILS on any
-- row still holding 'lookup' — `invalid input value for enum` — which is every
-- deployment that has ever created a lookup source, and it would fail after
-- the type had already been dropped.
--
-- `RENAME VALUE` is the operation that was meant: it is transactional (unlike
-- `ADD VALUE`), it rewrites nothing, and the partial unique index predicated on
-- `kind = 'table'` is untouched because that value does not move.
--
-- `snapshot.json` is left as generated — it records the END state, which is
-- what `db:check` and the next `db:generate` compare against. The SQL is
-- hashed only when it is first applied, so editing it before it ships is safe.
-- What `db:check` CANNOT do is notice this edit being wrong: that is the PR's job.
ALTER TYPE "collection_sync_kind" RENAME VALUE 'lookup' TO 'columns';
