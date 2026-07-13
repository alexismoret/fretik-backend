-- Custom SQL migration file, put your code below! --

-- Make the SQL-role SELECT policy on `object_types` grant-aware.
--
-- Before: a team saw only its OWN types + the org-scoped templates (team_id NULL).
-- A foreign type shared via `object_grants` had its DATA rows readable (the
-- registry + extension-table policies already call `fretik_type_granted`), but its
-- CATALOG row in `object_types` stayed invisible to the `fretik_sql_tool` role —
-- so a `querySql` JOIN to `object_types` for a granted type returned nothing.
--
-- After: add the same `fretik_type_granted(id)` branch the registry uses (the row's
-- own `id` IS the object-type id). The helper is STABLE SECURITY DEFINER + org-scoped,
-- so org-wide grants can't leak across organizations. Owner/template equality stays
-- the indexed fast path; the grant branch short-circuits cheaply for unshared rows.
DROP POLICY IF EXISTS sql_tool_team_isolation ON object_types;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON object_types
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = NULLIF(current_setting('fretik.team_id', true), '')::uuid
    OR (team_id IS NULL
        AND organization_id = NULLIF(current_setting('fretik.organization_id', true), '')::uuid)
    OR fretik_type_granted(id)
  );
