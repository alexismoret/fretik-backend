CREATE TYPE "access_level" AS ENUM('view', 'use', 'edit', 'full');--> statement-breakpoint
CREATE TYPE "access_principal_type" AS ENUM('user', 'team', 'project', 'organization', 'invitation');--> statement-breakpoint
CREATE TYPE "access_request_status" AS ENUM('pending', 'approved', 'denied', 'canceled');--> statement-breakpoint
CREATE TYPE "access_resource_type" AS ENUM('folder', 'document', 'page', 'workflow', 'conversation', 'collection', 'connection', 'project');--> statement-breakpoint
CREATE TYPE "team_role" AS ENUM('lead', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "access_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(64) NOT NULL,
	"resource_type" "access_resource_type",
	"resource_id" uuid,
	"principal_type" "access_principal_type",
	"principal_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"resource_type" "access_resource_type" NOT NULL,
	"resource_id" uuid NOT NULL,
	"principal_type" "access_principal_type" NOT NULL,
	"principal_id" uuid NOT NULL,
	"level" "access_level" NOT NULL,
	"granted_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"resource_type" "access_resource_type",
	"resource_id" uuid,
	"requested_level" "access_level",
	"capability" varchar(64),
	"team_id" uuid,
	"message" text,
	"status" "access_request_status" DEFAULT 'pending'::"access_request_status" NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"icon" varchar(64),
	"color" varchar(32),
	"owner_user_id" uuid,
	"access_restricted" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_member_roles" (
	"team_member_id" uuid PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_role" DEFAULT 'member'::"team_role" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "access_policy" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_settings" ADD COLUMN "access_policy" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "access_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "access_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "access_restricted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "access_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "access_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "access_audit_log_org_created_idx" ON "access_audit_log" ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_resource_principal_uidx" ON "access_grants" ("resource_type","resource_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "access_grants_principal_idx" ON "access_grants" ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "access_grants_org_idx" ON "access_grants" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_requests_pending_resource_uidx" ON "access_requests" ("requester_user_id","resource_type","resource_id") WHERE status = 'pending' AND resource_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "access_requests_pending_capability_uidx" ON "access_requests" ("requester_user_id","capability") WHERE status = 'pending' AND capability IS NOT NULL;--> statement-breakpoint
CREATE INDEX "access_requests_org_status_idx" ON "access_requests" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "access_requests_resource_idx" ON "access_requests" ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "projects_team_idx" ON "projects" ("team_id");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" ("organization_id");--> statement-breakpoint
CREATE INDEX "team_member_roles_user_idx" ON "team_member_roles" ("user_id");--> statement-breakpoint
CREATE INDEX "team_member_roles_team_idx" ON "team_member_roles" ("team_id");--> statement-breakpoint
CREATE INDEX "folders_project_idx" ON "folders" ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_conversations_project_idx" ON "ai_conversations" ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflows_project_idx" ON "workflows" ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pages_project_idx" ON "pages" ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "access_audit_log" ADD CONSTRAINT "access_audit_log_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_audit_log" ADD CONSTRAINT "access_audit_log_actor_user_id_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_by_user_id_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_user_id_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_user_id_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "team_member_roles" ADD CONSTRAINT "team_member_roles_team_member_id_team_member_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "team_member"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_member_roles" ADD CONSTRAINT "team_member_roles_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_member_roles" ADD CONSTRAINT "team_member_roles_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_member_roles" ADD CONSTRAINT "team_member_roles_updated_by_user_id_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id");--> statement-breakpoint
--
-- Hand-written: the backfill and the grant cleanup (drizzle-kit emits
-- neither).
--
-- Who owns what exists today. Nothing changes who can see it:
--   - Drive items keep inheriting their team, and are owned by whoever
--     uploaded or created them;
--   - pages and workflows read their legacy privacy column (`user_id`, set =
--     private) as the restriction, and the code keeps both in step from now
--     on (`db/schema/pages.ts`);
--   - conversations are restricted by the column default: private to their
--     participants, as they always were.
--
UPDATE documents SET owner_user_id = uploaded_by_id
  WHERE owner_user_id IS NULL AND uploaded_by_id IS NOT NULL;--> statement-breakpoint
UPDATE folders SET owner_user_id = created_by_id
  WHERE owner_user_id IS NULL AND created_by_id IS NOT NULL;--> statement-breakpoint
UPDATE pages
  SET owner_user_id = COALESCE(user_id, created_by_user_id),
      access_restricted = (user_id IS NOT NULL)
  WHERE owner_user_id IS NULL;--> statement-breakpoint
UPDATE workflows
  SET owner_user_id = COALESCE(user_id, created_by_user_id),
      access_restricted = (user_id IS NOT NULL)
  WHERE owner_user_id IS NULL;--> statement-breakpoint
--
-- `access_grants` and `access_requests` are polymorphic — no foreign key can
-- reach the resource or the principal they name — so these triggers do what
-- a cascade would. A grant left behind gives nothing (its resource is gone,
-- or its principal can no longer sign in), but it would read wrong in every
-- "who has access" list, and a stale request would wait forever.
--
CREATE OR REPLACE FUNCTION access_forget_resource() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access_grants
    WHERE resource_type = TG_ARGV[0]::access_resource_type
      AND resource_id = OLD.id;
  DELETE FROM access_requests
    WHERE resource_type = TG_ARGV[0]::access_resource_type
      AND resource_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER access_forget_folder AFTER DELETE ON folders
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('folder');--> statement-breakpoint
CREATE TRIGGER access_forget_document AFTER DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('document');--> statement-breakpoint
CREATE TRIGGER access_forget_page AFTER DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('page');--> statement-breakpoint
CREATE TRIGGER access_forget_workflow AFTER DELETE ON workflows
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('workflow');--> statement-breakpoint
CREATE TRIGGER access_forget_conversation AFTER DELETE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('conversation');--> statement-breakpoint
CREATE TRIGGER access_forget_collection AFTER DELETE ON collections
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('collection');--> statement-breakpoint
CREATE TRIGGER access_forget_connection AFTER DELETE ON external_app_connections
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('connection');--> statement-breakpoint
CREATE TRIGGER access_forget_project AFTER DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION access_forget_resource('project');--> statement-breakpoint
CREATE OR REPLACE FUNCTION access_forget_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access_grants
    WHERE principal_type = TG_ARGV[0]::access_principal_type
      AND principal_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER access_forget_user_grants AFTER DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION access_forget_principal('user');--> statement-breakpoint
CREATE TRIGGER access_forget_team_grants AFTER DELETE ON team
  FOR EACH ROW EXECUTE FUNCTION access_forget_principal('team');--> statement-breakpoint
CREATE TRIGGER access_forget_project_grants AFTER DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION access_forget_principal('project');--> statement-breakpoint
CREATE TRIGGER access_forget_invitation_grants AFTER DELETE ON invitation
  FOR EACH ROW EXECUTE FUNCTION access_forget_principal('invitation');--> statement-breakpoint
--
-- Leaving an organization takes one's grants in it with them. The person's
-- account may live on in other organizations, so this is keyed on the
-- membership, not on the user.
--
CREATE OR REPLACE FUNCTION access_forget_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access_grants
    WHERE organization_id = OLD.organization_id
      AND principal_type = 'user'
      AND principal_id = OLD.user_id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER access_forget_member_grants AFTER DELETE ON member
  FOR EACH ROW EXECUTE FUNCTION access_forget_member();
