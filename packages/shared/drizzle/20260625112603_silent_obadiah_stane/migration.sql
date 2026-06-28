CREATE TYPE "object_permission" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TABLE "object_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"object_type_id" uuid NOT NULL,
	"owner_team_id" uuid NOT NULL,
	"grantee_team_id" uuid,
	"permission" "object_permission" DEFAULT 'read'::"object_permission" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "record_shares" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"owner_team_id" uuid NOT NULL,
	"grantee_team_id" uuid,
	"permission" "object_permission" DEFAULT 'read'::"object_permission" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid
);
--> statement-breakpoint
DROP INDEX "object_records_data_gin_idx";--> statement-breakpoint
-- CASCADE: drop the old per-(team,type) `v_<key>_<teamhex>` cast-views and the
-- cast expression indexes that depended on the JSONB `data` column. They are
-- replaced by real typed tables in the `data` schema (see the custom block
-- below). Nothing is in production, so this is a clean break.
ALTER TABLE "object_records" DROP COLUMN "data" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "object_grants_type_grantee_uniq" ON "object_grants" ("object_type_id","grantee_team_id") WHERE grantee_team_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "object_grants_type_orgwide_uniq" ON "object_grants" ("object_type_id") WHERE grantee_team_id IS NULL;--> statement-breakpoint
CREATE INDEX "object_grants_grantee_idx" ON "object_grants" ("grantee_team_id");--> statement-breakpoint
CREATE INDEX "object_grants_type_idx" ON "object_grants" ("object_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_shares_record_grantee_uniq" ON "record_shares" ("record_id","grantee_team_id") WHERE grantee_team_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "record_shares_record_orgwide_uniq" ON "record_shares" ("record_id") WHERE grantee_team_id IS NULL;--> statement-breakpoint
CREATE INDEX "record_shares_grantee_idx" ON "record_shares" ("grantee_team_id");--> statement-breakpoint
CREATE INDEX "record_shares_record_idx" ON "record_shares" ("record_id");--> statement-breakpoint
ALTER TABLE "object_grants" ADD CONSTRAINT "object_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_grants" ADD CONSTRAINT "object_grants_object_type_id_object_types_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_grants" ADD CONSTRAINT "object_grants_owner_team_id_team_id_fkey" FOREIGN KEY ("owner_team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_grants" ADD CONSTRAINT "object_grants_grantee_team_id_team_id_fkey" FOREIGN KEY ("grantee_team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_grants" ADD CONSTRAINT "object_grants_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_record_id_object_records_id_fkey" FOREIGN KEY ("record_id") REFERENCES "object_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_owner_team_id_team_id_fkey" FOREIGN KEY ("owner_team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_grantee_team_id_team_id_fkey" FOREIGN KEY ("grantee_team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint

-- ============================================================================
-- Objects refonte — real typed tables. The custom primitives the runtime DDL
-- engine (services/object-schema) depends on. Authored by hand: the per-type
-- tables `data.obj_<typeId>` are created at runtime, not by drizzle.
-- ============================================================================

-- The single global schema holding every per-type physical table.
CREATE SCHEMA IF NOT EXISTS "data";--> statement-breakpoint
GRANT USAGE ON SCHEMA "data" TO fretik_sql_tool;--> statement-breakpoint

-- Session-scope helpers — the per-transaction RLS context the SQL tool sets
-- (`fretik.team_id` / `fretik.organization_id`). STABLE → evaluated once per
-- query (initPlan-cached) inside RLS predicates.
CREATE OR REPLACE FUNCTION fretik_team() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.team_id', true), '')::uuid
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_org() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.organization_id', true), '')::uuid
  $$;--> statement-breakpoint

-- Sharing predicates. SECURITY DEFINER so the least-privilege read role can
-- evaluate them WITHOUT direct SELECT on the grant tables, and so they never
-- trigger chained RLS. Org-scoped (organization_id = fretik_org()) so an
-- org-wide grant (grantee_team_id IS NULL) can never leak across organizations.
CREATE OR REPLACE FUNCTION fretik_type_granted(p_type uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM object_grants g
      WHERE g.object_type_id = p_type
        AND g.organization_id = fretik_org()
        AND (g.grantee_team_id = fretik_team() OR g.grantee_team_id IS NULL)
    )
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_record_shared(p_record uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM record_shares s
      WHERE s.record_id = p_record
        AND s.organization_id = fretik_org()
        AND (s.grantee_team_id = fretik_team() OR s.grantee_team_id IS NULL)
    )
  $$;--> statement-breakpoint

-- Registry read policy now honours sharing (was team-only). The owner equality
-- is the indexed fast path; the OR-branches short-circuit cheaply for unshared
-- rows. Extension tables get the equivalent policy from the DDL engine.
DROP POLICY IF EXISTS sql_tool_team_isolation ON object_records;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON object_records
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = fretik_team()
    OR fretik_type_granted(object_type_id)
    OR fretik_record_shared(id)
  );--> statement-breakpoint

-- Retire the JSONB date-cast helper — typed `date` columns make it obsolete.
-- (Its expression indexes were dropped with the `data` column CASCADE above.)
DROP FUNCTION IF EXISTS fretik_text_to_date(text);--> statement-breakpoint

-- Drop the last view: the chatbot now reads the real tables + registry directly,
-- so there are NO views. `v_record` was only sugar for object_records ⋈
-- object_types, which the SQL role can query itself (both are granted, RLS-fenced).
DROP VIEW IF EXISTS v_record;