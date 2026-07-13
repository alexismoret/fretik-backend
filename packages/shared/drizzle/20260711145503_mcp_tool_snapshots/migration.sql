CREATE TABLE "external_app_tool_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"provider_key" varchar(64) NOT NULL,
	"connection_id" uuid,
	"fingerprint" varchar(64) NOT NULL,
	"descriptor" jsonb NOT NULL,
	"sdk_py" text NOT NULL,
	"skill_md" text NOT NULL,
	"polished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "tool_fingerprint" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eats_curated" ON "external_app_tool_snapshots" ("provider_key","fingerprint") WHERE "connection_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eats_custom" ON "external_app_tool_snapshots" ("connection_id","fingerprint") WHERE "connection_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_eats_provider" ON "external_app_tool_snapshots" ("provider_key");--> statement-breakpoint
ALTER TABLE "external_app_tool_snapshots" ADD CONSTRAINT "external_app_tool_snapshots_gFUvhVPEhlTB_fkey" FOREIGN KEY ("connection_id") REFERENCES "external_app_connections"("id") ON DELETE CASCADE;