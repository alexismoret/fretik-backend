CREATE TYPE "collection_sync_kind" AS ENUM('table', 'lookup');--> statement-breakpoint
CREATE TYPE "collection_sync_orphan_policy" AS ENUM('keep', 'reject', 'delete');--> statement-breakpoint
CREATE TYPE "collection_sync_run_status" AS ENUM('running', 'success', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "collection_sync_run_trigger" AS ENUM('schedule', 'manual', 'event', 'open', 'initial');--> statement-breakpoint
CREATE TYPE "record_sync_status" AS ENUM('ok', 'error', 'missing', 'pending');--> statement-breakpoint
CREATE TABLE "collection_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"sync_source_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"status" "collection_sync_run_status" DEFAULT 'running'::"collection_sync_run_status" NOT NULL,
	"trigger" "collection_sync_run_trigger" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"orphan_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"upstream_calls" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"triggered_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "collection_sync_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"kind" "collection_sync_kind" NOT NULL,
	"connection_id" uuid,
	"provider_key" varchar(64) NOT NULL,
	"operation" varchar(120) NOT NULL,
	"args" jsonb DEFAULT '{}' NOT NULL,
	"result_path" text,
	"external_id_path" text,
	"field_mapping" jsonb DEFAULT '[]' NOT NULL,
	"schedule" jsonb DEFAULT '{"mode":"manual"}' NOT NULL,
	"orphan_policy" "collection_sync_orphan_policy" DEFAULT 'keep'::"collection_sync_orphan_policy" NOT NULL,
	"row_cap" integer DEFAULT 20000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_sync_state" (
	"record_id" uuid,
	"sync_source_id" uuid,
	"status" "record_sync_status" DEFAULT 'ok'::"record_sync_status" NOT NULL,
	"content_hash" varchar(64),
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_sync_state_pkey" PRIMARY KEY("record_id","sync_source_id")
);
--> statement-breakpoint
ALTER TABLE "collection_records" ADD COLUMN "sync_source_id" uuid;--> statement-breakpoint
ALTER TABLE "collection_records" ADD COLUMN "external_id" varchar(200);--> statement-breakpoint
ALTER TABLE "field_definitions" ADD COLUMN "sync_source_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_records_sync_external_uniq" ON "collection_records" ("sync_source_id","external_id") WHERE sync_source_id IS NOT NULL AND external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "field_definitions_sync_source_idx" ON "field_definitions" ("sync_source_id") WHERE sync_source_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "collection_sync_runs_source_started_idx" ON "collection_sync_runs" ("sync_source_id","started_at");--> statement-breakpoint
CREATE INDEX "collection_sync_runs_team_idx" ON "collection_sync_runs" ("team_id","started_at");--> statement-breakpoint
CREATE INDEX "collection_sync_sources_collection_idx" ON "collection_sync_sources" ("collection_id");--> statement-breakpoint
CREATE INDEX "collection_sync_sources_team_idx" ON "collection_sync_sources" ("team_id");--> statement-breakpoint
CREATE INDEX "collection_sync_sources_connection_idx" ON "collection_sync_sources" ("connection_id");--> statement-breakpoint
CREATE INDEX "collection_sync_sources_due_idx" ON "collection_sync_sources" ("next_run_at") WHERE enabled AND next_run_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_sync_sources_table_uniq" ON "collection_sync_sources" ("collection_id") WHERE kind = 'table';--> statement-breakpoint
CREATE INDEX "record_sync_state_source_synced_idx" ON "record_sync_state" ("sync_source_id","synced_at");--> statement-breakpoint
CREATE INDEX "record_sync_state_source_status_idx" ON "record_sync_state" ("sync_source_id","status");--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_USCpeyhFfLMH_fkey" FOREIGN KEY ("sync_source_id") REFERENCES "collection_sync_sources"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "collection_sync_runs" ADD CONSTRAINT "collection_sync_runs_2kQQwvI8EY1Z_fkey" FOREIGN KEY ("sync_source_id") REFERENCES "collection_sync_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_sync_runs" ADD CONSTRAINT "collection_sync_runs_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_sync_runs" ADD CONSTRAINT "collection_sync_runs_triggered_by_user_id_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD CONSTRAINT "collection_sync_sources_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD CONSTRAINT "collection_sync_sources_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD CONSTRAINT "collection_sync_sources_collection_id_collections_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD CONSTRAINT "collection_sync_sources_ZcsZnSy3MZW8_fkey" FOREIGN KEY ("connection_id") REFERENCES "external_app_connections"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD CONSTRAINT "collection_sync_sources_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "record_sync_state" ADD CONSTRAINT "record_sync_state_record_id_collection_records_id_fkey" FOREIGN KEY ("record_id") REFERENCES "collection_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_sync_state" ADD CONSTRAINT "record_sync_state_EnJxkiIcjQOn_fkey" FOREIGN KEY ("sync_source_id") REFERENCES "collection_sync_sources"("id") ON DELETE CASCADE;