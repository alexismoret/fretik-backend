CREATE TYPE "workflow_autonomy" AS ENUM('read_only', 'approval_required', 'autonomous');--> statement-breakpoint
CREATE TYPE "workflow_run_status" AS ENUM('queued', 'running', 'needs_approval', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "workflow_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "workflow_trigger_type" AS ENUM('manual', 'cron', 'event');--> statement-breakpoint
ALTER TYPE "ai_agent_type" ADD VALUE 'workflow';--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"workflow_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"acting_user_id" uuid,
	"triggered_by_user_id" uuid,
	"status" "workflow_run_status" DEFAULT 'queued'::"workflow_run_status" NOT NULL,
	"trigger_type" "workflow_trigger_type" NOT NULL,
	"trigger_payload" jsonb DEFAULT '{}' NOT NULL,
	"source_event_id" uuid,
	"conversation_id" uuid,
	"trigger_run_id" text,
	"wait_token_id" text,
	"task_states" jsonb DEFAULT '[]' NOT NULL,
	"last_turn_index" integer DEFAULT 0 NOT NULL,
	"last_turn_result" jsonb,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0,"turns":0}' NOT NULL,
	"output_summary" text,
	"outputs" jsonb,
	"error" jsonb,
	"is_test" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" varchar(60),
	"color" varchar(20),
	"status" "workflow_status" DEFAULT 'draft'::"workflow_status" NOT NULL,
	"trigger_type" "workflow_trigger_type" DEFAULT 'manual'::"workflow_trigger_type" NOT NULL,
	"trigger_config" jsonb DEFAULT '{}' NOT NULL,
	"playbook" jsonb NOT NULL,
	"autonomy" "workflow_autonomy" DEFAULT 'approval_required'::"workflow_autonomy" NOT NULL,
	"model_profile_key" varchar(64),
	"limits" jsonb DEFAULT '{}' NOT NULL,
	"trigger_schedule_id" text,
	"created_by_user_id" uuid,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_created_idx" ON "workflow_runs" ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_team_status_idx" ON "workflow_runs" ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_source_event_uniq" ON "workflow_runs" ("workflow_id","source_event_id") WHERE source_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflows_team_status_idx" ON "workflows" ("team_id","status");--> statement-breakpoint
CREATE INDEX "workflows_team_trigger_active_idx" ON "workflows" ("team_id","trigger_type") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_acting_user_id_user_id_fkey" FOREIGN KEY ("acting_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_triggered_by_user_id_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;