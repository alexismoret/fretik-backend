ALTER TYPE "domain_event_actor" ADD VALUE 'workflow';--> statement-breakpoint
CREATE TABLE "worker_cursors" (
	"name" text PRIMARY KEY,
	"position" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_event_links" ADD COLUMN "confidence" numeric(4,3);--> statement-breakpoint
ALTER TABLE "domain_event_links" ADD COLUMN "status" "ontology_status" DEFAULT 'confirmed'::"ontology_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_event_links" ADD COLUMN "source" "ontology_source" DEFAULT 'system'::"ontology_source" NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD COLUMN "agent_key" varchar(60);--> statement-breakpoint

-- worker_cursors is global infra state (journal consumption positions): RLS on
-- with NO policy and no GRANT — invisible to the fretik_sql_tool role.
ALTER TABLE "worker_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Collaborative journal visibility: align domain_events with the record-sharing
-- model (fat_speed migration). An event about a record shared into the caller's
-- team is visible alongside the record itself; team-owned events stay on the
-- owner fast path. fretik_record_visible() is STABLE SECURITY DEFINER.
DROP POLICY IF EXISTS sql_tool_team_isolation ON domain_events;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON domain_events
  FOR SELECT TO fretik_sql_tool
  USING (
    team_id = fretik_team()
    OR (subject_record_id IS NOT NULL AND fretik_record_visible(subject_record_id))
  );--> statement-breakpoint

-- Link rows follow either their parent event's visibility (the inner SELECT is
-- itself RLS-filtered; the explicit predicate is belt-and-suspenders, kept for
-- clarity) or the visibility of the record they point at.
DROP POLICY IF EXISTS sql_tool_team_isolation ON domain_event_links;--> statement-breakpoint
CREATE POLICY sql_tool_team_isolation ON domain_event_links
  FOR SELECT TO fretik_sql_tool
  USING (
    EXISTS (
      SELECT 1 FROM domain_events e
      WHERE e.id = domain_event_links.event_id
        AND (
          e.team_id = fretik_team()
          OR (e.subject_record_id IS NOT NULL AND fretik_record_visible(e.subject_record_id))
        )
    )
    OR fretik_record_visible(record_id)
  );