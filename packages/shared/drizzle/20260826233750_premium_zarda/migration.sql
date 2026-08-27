CREATE TABLE "external_app_connection_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"page_id" uuid,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eacp_page" ON "external_app_connection_preferences" ("user_id","team_id","provider_key","page_id") WHERE "page_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eacp_default" ON "external_app_connection_preferences" ("user_id","team_id","provider_key") WHERE "page_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_eacp_lookup" ON "external_app_connection_preferences" ("user_id","team_id","provider_key");--> statement-breakpoint
ALTER TABLE "external_app_connection_preferences" ADD CONSTRAINT "external_app_connection_preferences_6nCuFQF7Bgil_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connection_preferences" ADD CONSTRAINT "external_app_connection_preferences_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connection_preferences" ADD CONSTRAINT "external_app_connection_preferences_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connection_preferences" ADD CONSTRAINT "external_app_connection_preferences_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_app_connection_preferences" ADD CONSTRAINT "external_app_connection_preferences_LPyETXXY0TXq_fkey" FOREIGN KEY ("connection_id") REFERENCES "external_app_connections"("id") ON DELETE CASCADE;