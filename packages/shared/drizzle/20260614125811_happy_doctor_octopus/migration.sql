CREATE TABLE "team_ai_settings" (
	"team_id" uuid PRIMARY KEY,
	"flagship_profile_key" varchar(64),
	"workhorse_profile_key" varchar(64),
	"utility_profile_key" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "model_profile_key" varchar(64);--> statement-breakpoint
ALTER TABLE "team_ai_settings" ADD CONSTRAINT "team_ai_settings_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;