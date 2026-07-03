-- Field-type registry change: merge `datetime` into `date` (+ `hasTime` config),
-- add `location`, `unique_id`, and the system properties. The enum is recreated
-- (Postgres can't drop an enum value in place), so every `datetime` row must be
-- rekeyed to `date` BEFORE the cast back, and the date-family columns migrated
-- from `date` to `timestamptz` (the date family is now always an instant).

ALTER TABLE "field_definitions" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
-- Rekey datetime → date with `hasTime: true` (done while the column is plain
-- text, so the value is not yet constrained by the enum being recreated below).
UPDATE "field_definitions"
SET "type" = 'date',
    "config" = jsonb_set(COALESCE("config", '{}'::jsonb), '{hasTime}', 'true'::jsonb, true)
WHERE "type" = 'datetime';--> statement-breakpoint
DROP TYPE "field_definition_type";--> statement-breakpoint
CREATE TYPE "field_definition_type" AS ENUM('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email', 'relation', 'member', 'money', 'markdown', 'rating', 'phone', 'location', 'unique_id', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by', 'rollup');--> statement-breakpoint
ALTER TABLE "field_definitions" ALTER COLUMN "type" SET DATA TYPE "field_definition_type" USING "type"::"field_definition_type";--> statement-breakpoint
-- Migrate existing per-type `date` columns to `timestamptz`. In the `data`
-- schema, a `date`-typed column can only come from a date field (no other field
-- type maps to `date`), so converting every one is safe. Cast through UTC so the
-- stored calendar day becomes midnight UTC regardless of the session time zone —
-- matching how the read path reconstructs a time-less date.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'data' AND data_type = 'date'
  LOOP
    EXECUTE format(
      'ALTER TABLE data.%I ALTER COLUMN %I TYPE timestamptz USING (%I::timestamp AT TIME ZONE ''UTC'')',
      r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;
