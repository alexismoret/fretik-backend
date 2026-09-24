--
-- Hand-written, because drizzle-kit does not emit RLS.
--
-- The agent's SQL tool reads the Drive as the person it acts for does. Its
-- policies used to scope documents and folders to the team alone, so a file
-- restricted to some people, a folder kept from the team, and the record that
-- mirrors such a file (`collection_records.document_id`, the file's name and
-- fields in the collections) were readable by anyone who asked the agent.
--
-- The app computes the person's reach per query (`authz/sql-tool-scope.ts`)
-- and sets it beside the team, transaction-local (`runReadonlyQuery`):
--
--   fretik.user_id          the person
--   fretik.reach            the grant principals that reach them at `view`
--   fretik.containers       the teams and projects whose content they view
--   fretik.hidden_folders   the team's folders they cannot open
--   fretik.private_folders  the organization's folders not open to their own
--                           whole team (restricted, in a project, or below
--                           one that is)
--
-- These say what `authz/drive-sql.ts` says, as SQL the policies can read. An
-- unset list reads as NULL, and every test against NULL fails: a query
-- without the scope sees nothing it would need the scope to see.
--
CREATE OR REPLACE FUNCTION fretik_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.user_id', true), '')::uuid
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_reach() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.reach', true), '')::uuid[]
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_containers() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.containers', true), '')::uuid[]
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_hidden_folders() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.hidden_folders', true), '')::uuid[]
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_private_folders() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('fretik.private_folders', true), '')::uuid[]
  $$;--> statement-breakpoint
--
-- An explicit grant on the resource reaches the person. SECURITY DEFINER: the
-- tool's role does not read `access_grants`, and should not.
--
CREATE OR REPLACE FUNCTION fretik_granted(p_type access_resource_type, p_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM access_grants g
      WHERE g.resource_type = p_type
        AND g.resource_id = p_id
        AND g.organization_id = fretik_org()
        AND g.principal_type <> 'invitation'
        AND g.principal_id = ANY(fretik_reach())
        AND (g.expires_at IS NULL OR g.expires_at > now())
    )
  $$;--> statement-breakpoint
--
-- A document the person can open, from its own columns: its owner, a grant,
-- or — not restricted — its container at the drive root, or a folder of the
-- team they can open. Cheapest arm first: most rows stop at the first.
--
CREATE OR REPLACE FUNCTION fretik_document_open(
  p_id uuid,
  p_team uuid,
  p_project uuid,
  p_folder uuid,
  p_owner uuid,
  p_restricted boolean
) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT (
      NOT p_restricted AND (
        (p_folder IS NULL AND COALESCE(p_project, p_team) = ANY(fretik_containers()))
        OR (
          p_folder IS NOT NULL
          AND p_team = fretik_team()
          AND NOT (p_folder = ANY(fretik_hidden_folders()))
        )
      )
    )
    OR p_owner = fretik_user()
    OR fretik_granted('document', p_id)
  $$;--> statement-breakpoint
--
-- A record that mirrors this document may be read: the person can open the
-- file, or the file is open to its whole team — then it is no one's secret,
-- and the record's own sharing decides, as for any record. SECURITY DEFINER:
-- the file may be another team's, which the tool's own policy hides.
--
CREATE OR REPLACE FUNCTION fretik_mirror_visible(p_document uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = p_document
        AND (
          (
            NOT d.access_restricted
            AND d.project_id IS NULL
            AND (d.folder_id IS NULL OR NOT (d.folder_id = ANY(fretik_private_folders())))
          )
          OR fretik_document_open(
            d.id, d.team_id, d.project_id, d.folder_id,
            COALESCE(d.owner_user_id, d.uploaded_by_id), d.access_restricted
          )
        )
    )
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fretik_record_mirror_visible(p_record uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM collection_records r
      WHERE r.id = p_record
        AND r.document_id IS NOT NULL
        AND NOT fretik_mirror_visible(r.document_id)
    )
  $$;--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON documents;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON documents
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = fretik_team()
    AND fretik_document_open(
      id, team_id, project_id, folder_id,
      COALESCE(owner_user_id, uploaded_by_id), access_restricted
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS sql_tool_team_isolation ON folders;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON folders
  FOR SELECT TO fretik_sql_tool
  USING (team_id = fretik_team() AND NOT (id = ANY(fretik_hidden_folders())));--> statement-breakpoint
--
-- `document_properties` keeps its policy: it reads `documents` through the
-- tool's own policy above, so a hidden file's properties go with it.
--
DROP POLICY IF EXISTS sql_tool_team_isolation ON collection_records;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON collection_records
  FOR SELECT TO fretik_sql_tool
  USING (
    (team_id = fretik_team() OR fretik_record_visible(id))
    AND (document_id IS NULL OR fretik_mirror_visible(document_id))
  );--> statement-breakpoint
--
-- The typed table of each organization's file collection holds one row per
-- mirror: it takes the same test, by record (`collection-schema/table.ts`
-- arms a new one the same way). Every other typed table holds no mirror.
--
DO $$
DECLARE
  c record;
  t text;
BEGIN
  FOR c IN SELECT id FROM collections WHERE key = 'document_record' LOOP
    t := 'data.coll_' || replace(c.id::text, '-', '');
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS sql_tool_read ON %s', t);
      EXECUTE format(
        'CREATE POLICY sql_tool_read ON %s FOR SELECT TO fretik_sql_tool USING ((_team_id = fretik_team() OR fretik_record_visible(id)) AND fretik_record_mirror_visible(id))',
        t
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
--
-- The journal names files and folders: an entry about one shows to those who
-- can open it. Once the item is gone its entry says whether its whole team
-- could open it (`teamOpen`, written at deletion), and only then does it show.
--
DROP POLICY IF EXISTS sql_tool_team_isolation ON domain_events;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON domain_events
  FOR SELECT TO fretik_sql_tool
  USING (
    split_part(type, '.', 1) IN (
      'record', 'link', 'document', 'folder', 'collection', 'field', 'link_type'
    )
    AND (
      team_id = fretik_team()
      OR (subject_record_id IS NOT NULL AND fretik_record_visible(subject_record_id))
    )
    AND (
      payload->>'documentId' IS NULL
      OR (payload->>'teamOpen')::boolean IS TRUE
      OR fretik_mirror_visible((payload->>'documentId')::uuid)
    )
    AND (
      subject_type IS DISTINCT FROM 'folder'
      OR (payload->>'teamOpen')::boolean IS TRUE
      OR EXISTS (
        SELECT 1 FROM folders f WHERE f.id = (payload->>'folderId')::uuid
      )
    )
    AND (subject_record_id IS NULL OR fretik_record_mirror_visible(subject_record_id))
  );
