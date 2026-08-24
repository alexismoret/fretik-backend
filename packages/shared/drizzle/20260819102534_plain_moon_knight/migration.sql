CREATE TYPE "document_source" AS ENUM('uploaded', 'authored');--> statement-breakpoint
CREATE TYPE "document_version_actor" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"document_id" uuid,
	"team_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"operation" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"file_size" bigint NOT NULL,
	"file_hash" text NOT NULL,
	"by_user_id" uuid,
	"by_actor" "document_version_actor" NOT NULL,
	"by_conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source" "document_source" DEFAULT 'uploaded'::"document_source" NOT NULL;--> statement-breakpoint
CREATE INDEX "document_versions_document_idx" ON "document_versions" ("document_id");--> statement-breakpoint
CREATE INDEX "document_versions_team_created_idx" ON "document_versions" ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_number_unique" ON "document_versions" ("document_id","version_number");--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_by_user_id_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_by_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("by_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;