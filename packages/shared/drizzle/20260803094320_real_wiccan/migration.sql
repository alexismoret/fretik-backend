CREATE TABLE "conversation_background_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_background_tasks_kind_ref_uniq" ON "conversation_background_tasks" ("kind","ref");--> statement-breakpoint
CREATE INDEX "conversation_background_tasks_conversation_idx" ON "conversation_background_tasks" ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_background_tasks_pending_idx" ON "conversation_background_tasks" ("created_at") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "conversation_background_tasks" ADD CONSTRAINT "conversation_background_tasks_hf91qR8LipOp_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;