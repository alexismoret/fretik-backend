CREATE TYPE "ai_checkpoint_kind" AS ENUM('llm', 'mechanical', 'truncated');--> statement-breakpoint
CREATE TABLE "ai_conversation_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"conversation_id" uuid NOT NULL,
	"up_to_message_id" uuid NOT NULL,
	"up_to_seq" bigint NOT NULL,
	"summary" text NOT NULL,
	"activated_tools" jsonb DEFAULT '[]' NOT NULL,
	"participant_ids" jsonb DEFAULT '[]' NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"kind" "ai_checkpoint_kind" NOT NULL,
	"tokens_before" bigint NOT NULL,
	"tokens_after" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversation_checkpoints_conv_seq_idx" ON "ai_conversation_checkpoints" ("conversation_id","up_to_seq");--> statement-breakpoint
ALTER TABLE "ai_conversation_checkpoints" ADD CONSTRAINT "ai_conversation_checkpoints_9hbEhymAL6Ty_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_conversation_checkpoints" ADD CONSTRAINT "ai_conversation_checkpoints_iz28T9C3WaIS_fkey" FOREIGN KEY ("up_to_message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE;