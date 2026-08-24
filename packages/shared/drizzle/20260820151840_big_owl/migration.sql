CREATE TABLE "page_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"page_id" uuid,
	"team_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"operation" text NOT NULL,
	"definition" jsonb NOT NULL,
	"name" varchar(120) NOT NULL,
	"by_user_id" uuid,
	"by_actor" text NOT NULL,
	"by_conversation_id" uuid,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_page_number_unique" ON "page_versions" ("page_id","version_number");--> statement-breakpoint
CREATE INDEX "page_versions_team_created_idx" ON "page_versions" ("team_id","created_at");--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_by_user_id_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_by_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("by_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;