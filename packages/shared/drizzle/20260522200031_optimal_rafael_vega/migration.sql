CREATE TYPE "external_app_connection_status" AS ENUM('active', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "tool_approval_status" AS ENUM('pending', 'granted', 'executing', 'consumed', 'rejected');--> statement-breakpoint
CREATE TABLE "external_app_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"provider_key" varchar(64) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"nango_connection_id" varchar(128) NOT NULL,
	"nango_provider_config_key" varchar(64) NOT NULL,
	"status" "external_app_connection_status" DEFAULT 'active'::"external_app_connection_status" NOT NULL,
	"last_error_message" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" varchar(128) NOT NULL,
	"lookup_hash" varchar(64) NOT NULL,
	"operations" jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"result" jsonb,
	"status" "tool_approval_status" DEFAULT 'pending'::"tool_approval_status" NOT NULL,
	"decision_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decision_feedback" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eac_nango" ON "external_app_connections" ("nango_connection_id","nango_provider_config_key");--> statement-breakpoint
CREATE INDEX "idx_eac_team_provider" ON "external_app_connections" ("team_id","provider_key");--> statement-breakpoint
CREATE INDEX "idx_eac_user_provider" ON "external_app_connections" ("user_id","provider_key");--> statement-breakpoint
CREATE INDEX "idx_tar_lookup" ON "tool_approval_requests" ("conversation_id","lookup_hash","status");--> statement-breakpoint
CREATE INDEX "idx_tar_conversation" ON "tool_approval_requests" ("conversation_id");--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD CONSTRAINT "external_app_connections_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD CONSTRAINT "external_app_connections_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD CONSTRAINT "external_app_connections_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD CONSTRAINT "external_app_connections_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_decided_by_user_id_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;