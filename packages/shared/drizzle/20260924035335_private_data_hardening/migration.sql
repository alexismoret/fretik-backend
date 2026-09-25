ALTER TABLE "workflows" DROP CONSTRAINT "workflows_user_id_user_id_fkey", ADD CONSTRAINT "workflows_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" DROP CONSTRAINT "pages_user_id_user_id_fkey", ADD CONSTRAINT "pages_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
--
-- Hand-written, because drizzle-kit does not emit RLS.
--
-- The agent's SQL tool reads the journal to answer "what happened to this
-- record". The policy used to expose every event of the team, and the journal
-- also carries events whose payload is someone's PRIVATE work: `chat.turn`
-- stores the opening of each message and reply of every conversation (solo
-- ones included), `memory.*` the paths of private memories, `episode.*` the
-- titles of private episodes, `workflow.*` the runs of private workflows. Any
-- member could read them by asking the agent for `SELECT payload FROM
-- domain_events`.
--
-- The tool now sees the families that describe the team's CONTENT — the ones
-- its prompt documents — and nothing else. An allowlist, not a denylist: a
-- family added later stays out of the agent's reach until someone decides it
-- belongs there. Event LINK rows keep their policy: a link of a hidden event
-- names only ids, and joining back to its event finds nothing.
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
  );
