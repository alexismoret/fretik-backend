CREATE TABLE "bulk_operation_chunks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"operation_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"item_count" integer NOT NULL,
	"items" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" varchar(128) NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"mode" text NOT NULL,
	"lookup_hash" varchar(64) NOT NULL,
	"total_items" integer NOT NULL,
	"chunk_size" integer NOT NULL,
	"params" jsonb NOT NULL,
	"sample" jsonb NOT NULL,
	"columns" jsonb,
	"approval_id" uuid,
	"progress" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_operation_chunks_operation_index_uniq" ON "bulk_operation_chunks" ("operation_id","chunk_index");--> statement-breakpoint
CREATE INDEX "bulk_operation_chunks_pending_idx" ON "bulk_operation_chunks" ("operation_id","chunk_index") WHERE applied_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_operations_conversation_hash_uniq" ON "bulk_operations" ("conversation_id","lookup_hash");--> statement-breakpoint
CREATE INDEX "bulk_operations_approval_idx" ON "bulk_operations" ("approval_id");--> statement-breakpoint
CREATE INDEX "bulk_operations_status_idx" ON "bulk_operations" ("status","created_at");--> statement-breakpoint
ALTER TABLE "bulk_operation_chunks" ADD CONSTRAINT "bulk_operation_chunks_operation_id_bulk_operations_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "bulk_operations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_approval_id_tool_approval_requests_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "tool_approval_requests"("id") ON DELETE SET NULL;