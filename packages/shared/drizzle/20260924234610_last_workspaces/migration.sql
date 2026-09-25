-- Where each person last worked (`last_workspaces`): the organization and
-- team their session had open, so a new session opens there instead of
-- asking again. One row per person, a preference and never a permission: it
-- is checked against today's memberships before a session opens on it.
-- Expand-only: a new table, nothing existing changes.
CREATE TABLE "last_workspaces" (
	"user_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "last_workspaces_organization_idx" ON "last_workspaces" ("organization_id");--> statement-breakpoint
CREATE INDEX "last_workspaces_team_idx" ON "last_workspaces" ("team_id");--> statement-breakpoint
ALTER TABLE "last_workspaces" ADD CONSTRAINT "last_workspaces_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "last_workspaces" ADD CONSTRAINT "last_workspaces_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "last_workspaces" ADD CONSTRAINT "last_workspaces_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE SET NULL;