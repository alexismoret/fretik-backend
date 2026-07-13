ALTER TYPE "tool_approval_kind" ADD VALUE 'external_app_read' BEFORE 'record_write';--> statement-breakpoint
ALTER TYPE "tool_approval_kind" ADD VALUE 'tool_call' BEFORE 'question';--> statement-breakpoint
CREATE TABLE "team_tool_policies" (
	"team_id" uuid PRIMARY KEY,
	"policies" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "action_policies" jsonb;--> statement-breakpoint
ALTER TABLE "team_tool_policies" ADD CONSTRAINT "team_tool_policies_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;