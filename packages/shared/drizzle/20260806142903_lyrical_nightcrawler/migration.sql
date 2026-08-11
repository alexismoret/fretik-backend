CREATE TABLE "page_shares" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"page_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" varchar(60),
	"color" varchar(20),
	"definition" jsonb NOT NULL,
	"public_token" uuid UNIQUE,
	"published_definition" jsonb,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"source_conversation_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "page_shares_page_team_uniq" ON "page_shares" ("page_id","team_id");--> statement-breakpoint
CREATE INDEX "page_shares_team_idx" ON "page_shares" ("team_id");--> statement-breakpoint
CREATE INDEX "pages_team_idx" ON "pages" ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "pages_org_idx" ON "pages" ("organization_id");--> statement-breakpoint
ALTER TABLE "page_shares" ADD CONSTRAINT "page_shares_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_shares" ADD CONSTRAINT "page_shares_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_shares" ADD CONSTRAINT "page_shares_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_published_by_user_id_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_source_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("source_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;