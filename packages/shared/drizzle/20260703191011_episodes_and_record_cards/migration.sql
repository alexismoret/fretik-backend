CREATE TYPE "ai_episode_kind" AS ENUM('conversation', 'record_activity', 'consolidated');--> statement-breakpoint
CREATE TYPE "ai_episode_state" AS ENUM('active', 'demoted', 'superseded');--> statement-breakpoint
ALTER TYPE "ai_vector_source_type" ADD VALUE 'episodes';--> statement-breakpoint
ALTER TYPE "ai_vector_source_type" ADD VALUE 'records';--> statement-breakpoint
CREATE TABLE "ai_episode_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"episode_id" uuid NOT NULL,
	"record_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_episodes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" "ai_episode_kind" NOT NULL,
	"state" "ai_episode_state" DEFAULT 'active'::"ai_episode_state" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"conversation_id" uuid,
	"anchor_record_id" uuid,
	"occurred_from" timestamp with time zone,
	"occurred_to" timestamp with time zone,
	"superseded_by_id" uuid,
	"content_hash" text NOT NULL,
	"last_recalled_at" timestamp with time zone,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"demoted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "object_records" DROP COLUMN "embedding";--> statement-breakpoint
CREATE UNIQUE INDEX "ai_episode_records_uniq" ON "ai_episode_records" ("episode_id","record_id");--> statement-breakpoint
CREATE INDEX "ai_episode_records_record_idx" ON "ai_episode_records" ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_episodes_conversation_active_uniq" ON "ai_episodes" ("conversation_id") WHERE kind = 'conversation' AND state = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_episodes_record_activity_active_uniq" ON "ai_episodes" ("anchor_record_id") WHERE kind = 'record_activity' AND state = 'active';--> statement-breakpoint
CREATE INDEX "ai_episodes_team_state_recalled_idx" ON "ai_episodes" ("team_id","state","last_recalled_at");--> statement-breakpoint
CREATE INDEX "ai_episodes_team_kind_idx" ON "ai_episodes" ("team_id","kind");--> statement-breakpoint
ALTER TABLE "ai_episode_records" ADD CONSTRAINT "ai_episode_records_episode_id_ai_episodes_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "ai_episodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_episode_records" ADD CONSTRAINT "ai_episode_records_record_id_object_records_id_fkey" FOREIGN KEY ("record_id") REFERENCES "object_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_episodes" ADD CONSTRAINT "ai_episodes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_episodes" ADD CONSTRAINT "ai_episodes_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_episodes" ADD CONSTRAINT "ai_episodes_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_episodes" ADD CONSTRAINT "ai_episodes_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_episodes" ADD CONSTRAINT "ai_episodes_anchor_record_id_object_records_id_fkey" FOREIGN KEY ("anchor_record_id") REFERENCES "object_records"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_episodes" ADD CONSTRAINT "ai_episodes_superseded_by_id_ai_episodes_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "ai_episodes"("id") ON DELETE SET NULL;