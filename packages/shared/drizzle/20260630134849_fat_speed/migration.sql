ALTER TABLE "object_records" ADD COLUMN "inherit_type_sharing" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- Cross-team record visibility now depends on the per-record `inherit_type_sharing`
-- flag: a record only rides its TYPE's grant while it inherits; a custom record
-- (inherit=false) is visible solely via its own `record_shares`, so it can be
-- NARROWER than its type. `fretik_record_visible(record)` folds both arms (the
-- type-grant-with-inherit AND the record-share) into one helper so the registry
-- policy and every `data.obj_*` extension policy share IDENTICAL text. STABLE
-- SECURITY DEFINER: evaluated against the registry without chained RLS, and only
-- on the OR-branch (the `_team_id = fretik_team()` owner equality short-circuits
-- first for own rows).
CREATE OR REPLACE FUNCTION fretik_record_visible(p_record uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM object_records r
      WHERE r.id = p_record
        AND r.inherit_type_sharing
        AND fretik_type_granted(r.object_type_id)
    ) OR fretik_record_shared(p_record)
  $$;--> statement-breakpoint

-- Registry read policy: owner fast path OR the shared-visibility helper.
DROP POLICY IF EXISTS sql_tool_team_isolation ON object_records;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON object_records
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = fretik_team()
    OR fretik_record_visible(id)
  );--> statement-breakpoint

-- Re-arm every existing extension table with the same helper-based policy. New
-- tables get this form from the DDL engine (`armTableSecurity`). The policy text
-- is type-independent, so no per-type id reconstruction is needed.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT format('%I.%I', schemaname, tablename)
    FROM pg_tables WHERE schemaname = 'data'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS sql_tool_read ON %s', t);
    EXECUTE format(
      'CREATE POLICY sql_tool_read ON %s FOR SELECT TO fretik_sql_tool USING (_team_id = fretik_team() OR fretik_record_visible(id))',
      t
    );
  END LOOP;
END $$;--> statement-breakpoint
