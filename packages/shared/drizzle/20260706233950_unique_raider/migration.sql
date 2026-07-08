CREATE TYPE "tool_approval_kind" AS ENUM('external_app_plan', 'record_write', 'question');--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD COLUMN "kind" "tool_approval_kind" DEFAULT 'external_app_plan'::"tool_approval_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "source_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ALTER COLUMN "lookup_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ALTER COLUMN "operations" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ALTER COLUMN "item_count" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ALTER COLUMN "summary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_source_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("source_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;