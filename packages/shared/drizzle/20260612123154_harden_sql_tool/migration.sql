-- C10 — Chatbot SQL-tool hardening.
--
-- The agent SQL tool stops sharing the app owner connection. It now runs as a
-- dedicated least-privilege role `fretik_sql_tool` (env AI_DB_READONLY_URL) that
-- can only SELECT an explicit allowlist of product tables, and every team-scoped
-- table is fenced by row-level security keyed on a per-transaction session
-- variable. The agent never reads auth/secret tables (account, two_factor,
-- session, …) nor cross-org identity — identity is exposed only through the
-- curated `chatbot_org_members` view.
--
-- This migration runs as the app owner at boot under the advisory lock. RLS is
-- ENABLE-only (never FORCE): the owner keeps bypassing RLS so the API/worker are
-- unaffected; only the non-owner `fretik_sql_tool` role is constrained.
--
-- Operator follow-up (out of VCS): set the role's password and wire
-- AI_DB_READONLY_URL — `ALTER ROLE fretik_sql_tool LOGIN PASSWORD '…';`.

-- 1. Dedicated role (idempotent). Created with LOGIN but no password, so it
--    cannot authenticate until the operator sets one — fail-safe by default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fretik_sql_tool') THEN
    CREATE ROLE fretik_sql_tool LOGIN;
  END IF;
END
$$;--> statement-breakpoint

-- 2. Schema access: USAGE only, never CREATE.
REVOKE ALL ON SCHEMA public FROM fretik_sql_tool;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fretik_sql_tool;--> statement-breakpoint

-- 3. Read allowlist — product tables only. No GRANT on auth/secret/config tables.
GRANT SELECT ON
  documents,
  document_properties,
  document_field_values,
  entities,
  document_entities,
  folders,
  labels,
  document_labels,
  field_definitions
TO fretik_sql_tool;--> statement-breakpoint

-- 4. RLS on directly team-scoped tables (team_id column).
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON documents;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON documents
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON entities;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON entities
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON folders;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON folders
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON labels;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON labels
  FOR SELECT TO fretik_sql_tool
  USING (team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid);--> statement-breakpoint

-- 5. RLS on child tables scoped through their parent document. The inner SELECT
--    on `documents` is itself RLS-filtered for fretik_sql_tool, so the team_id
--    predicate is belt-and-suspenders but kept explicit.
ALTER TABLE document_properties ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON document_properties;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON document_properties
  FOR SELECT TO fretik_sql_tool
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_properties.document_id
      AND d.team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
  ));--> statement-breakpoint

ALTER TABLE document_field_values ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON document_field_values;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON document_field_values
  FOR SELECT TO fretik_sql_tool
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_field_values.document_id
      AND d.team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
  ));--> statement-breakpoint

ALTER TABLE document_entities ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON document_entities;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON document_entities
  FOR SELECT TO fretik_sql_tool
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_entities.document_id
      AND d.team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
  ));--> statement-breakpoint

ALTER TABLE document_labels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON document_labels;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON document_labels
  FOR SELECT TO fretik_sql_tool
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_labels.document_id
      AND d.team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
  ));--> statement-breakpoint

-- 6. field_definitions: team rows OR org-level templates (team_id IS NULL).
ALTER TABLE field_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON field_definitions;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON field_definitions
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
    OR (team_id IS NULL
        AND organization_id = NULLIF(current_setting('fretik.organization_id', true), '')::uuid)
  );--> statement-breakpoint

-- 7. Curated identity view. Owner-semantics (default security_invoker = false):
--    the view reads "user"/member as the owner, so fretik_sql_tool needs no GRANT
--    on those tables and can never widen the projection. Scoped to the current
--    org via the session variable; sensitive columns (is_super_admin,
--    two_factor_enabled, image) are never selected.
CREATE OR REPLACE VIEW chatbot_org_members AS
  SELECT u.id AS user_id,
         u.name,
         u.email,
         m.organization_id
  FROM "user" u
  JOIN member m ON m.user_id = u.id
  WHERE m.organization_id = NULLIF(current_setting('fretik.organization_id', true), '')::uuid;--> statement-breakpoint
GRANT SELECT ON chatbot_org_members TO fretik_sql_tool;
