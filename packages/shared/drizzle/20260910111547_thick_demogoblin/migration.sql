CREATE TABLE "team_memory_digests" (
	"team_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"content" text NOT NULL,
	"previous_content" text,
	"token_count" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_fingerprint" text NOT NULL,
	"sources" jsonb DEFAULT '{"memoryPaths":[],"episodeIds":[],"recordIds":[]}' NOT NULL,
	"model_profile_key" varchar(128),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_memory_digests" ADD CONSTRAINT "team_memory_digests_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_memory_digests" ADD CONSTRAINT "team_memory_digests_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;