-- Phase 3 — Dynamic-data graph: the chatbot SQL-tool query surface.
--
-- Mirrors `harden_sql_tool` (C10) for the new unified graph. The agent SQL tool
-- runs as the least-privilege role `fretik_sql_tool` (env AI_DB_READONLY_URL),
-- which gains SELECT on the graph tables + the typed `v_*` views, every
-- team-scoped table fenced by row-level security keyed on the per-transaction
-- `fretik.team_id` / `fretik.organization_id` session variables.
--
-- The model NEVER references `object_records` / `object_types` directly — the
-- AST sanitizer forbids it — but the typed views run with `security_invoker`, so
-- the role still needs DB-level SELECT + RLS on those base tables for the views
-- to execute. Raw JSONB is thus never in the model's surface (max text-to-SQL
-- precision); the views are the only data path, the graph relations the only
-- join path.
--
-- Runs as the app owner at boot under the advisory lock. RLS is ENABLE-only
-- (never FORCE): the owner keeps bypassing RLS so the API/worker are unaffected;
-- only the non-owner `fretik_sql_tool` role is constrained. The role itself is
-- created by `harden_sql_tool` (earlier migration).

-- 1. Read allowlist — graph base tables + catalog. object_records / object_types
--    back the security_invoker views; the model can't name them (sanitizer), but
--    the views need the grant to execute. links / link_types / domain_events /
--    domain_event_links ARE in the sanitizer allowlist (the model's join path).
GRANT SELECT ON
  object_records,
  object_types,
  links,
  link_types,
  domain_events,
  domain_event_links
TO fretik_sql_tool;--> statement-breakpoint

-- 2. RLS on directly team-scoped graph tables (team_id column) — the simple arm.
ALTER TABLE object_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON object_records;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON object_records
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON links;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON links
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON domain_events;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON domain_events
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

-- 3. domain_event_links has no team_id — scope through its parent event. The
--    inner SELECT on domain_events is itself RLS-filtered, so the team_id
--    predicate is belt-and-suspenders but kept explicit.
ALTER TABLE domain_event_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON domain_event_links;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON domain_event_links
  FOR SELECT TO fretik_sql_tool
  USING (EXISTS (
    SELECT 1 FROM domain_events e
    WHERE e.id = domain_event_links.event_id
      AND e.team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
  ));--> statement-breakpoint

-- 4. Catalog tables carrying org templates / system rows (object_types,
--    link_types): the DOUBLE-ARMED policy — team rows OR org-level rows
--    (team_id IS NULL within the caller's org). Copied verbatim from
--    field_definitions in harden_sql_tool; the simple team-only arm would hide
--    the system `company` type and the org-scoped link types from the team, and
--    the killer-query JOIN would return empty.
ALTER TABLE object_types ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON object_types;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON object_types
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
    OR (team_id IS NULL
        AND organization_id = NULLIF(current_setting('fretik.organization_id', true), '')::uuid)
  );--> statement-breakpoint

ALTER TABLE link_types ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON link_types;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON link_types
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
    OR (team_id IS NULL
        AND organization_id = NULLIF(current_setting('fretik.organization_id', true), '')::uuid)
  );--> statement-breakpoint

-- 5. Generic record view (stable, global, security_invoker → RLS above applies).
--    Common columns only, never `data` — for resolving a polymorphic link target
--    whose concrete type the model doesn't know. Structural columns are
--    `_`-prefixed so they can never collide with a typed view's field columns.
--    Per-type `v_<key>_<teamhex>` views are dynamic (catalog-dependent) and are
--    built by `services/object-types/sync-typed-view` + the
--    `scripts/sync-typed-views.ts` backfill, not here.
CREATE OR REPLACE VIEW v_record WITH (security_invoker = on) AS
  SELECT r.id AS _id,
         ot.key AS _type_key,
         r.label AS _label,
         r.status::text AS _status
  FROM object_records r
  JOIN object_types ot ON ot.id = r.object_type_id;--> statement-breakpoint
GRANT SELECT ON v_record TO fretik_sql_tool;
