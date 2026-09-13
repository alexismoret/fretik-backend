CREATE TYPE "chat_suggestion_kind" AS ENUM('pending', 'follow_up', 'periodic', 'insight', 'capability');--> statement-breakpoint
CREATE TYPE "chat_suggestion_status" AS ENUM('active', 'used', 'dismissed', 'superseded');--> statement-breakpoint
CREATE TABLE "chat_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" "chat_suggestion_kind" NOT NULL,
	"label" varchar(80) NOT NULL,
	"prompt" text NOT NULL,
	"reason" varchar(160) NOT NULL,
	"source_refs" jsonb DEFAULT '[]' NOT NULL,
	"status" "chat_suggestion_status" DEFAULT 'active'::"chat_suggestion_status" NOT NULL,
	"input_hash" text NOT NULL,
	"model_key" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "chat_suggestions_user_team_status_idx" ON "chat_suggestions" ("user_id","team_id","status");--> statement-breakpoint
CREATE INDEX "chat_suggestions_user_resolved_idx" ON "chat_suggestions" ("user_id","resolved_at");--> statement-breakpoint
ALTER TABLE "chat_suggestions" ADD CONSTRAINT "chat_suggestions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_suggestions" ADD CONSTRAINT "chat_suggestions_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_suggestions" ADD CONSTRAINT "chat_suggestions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;