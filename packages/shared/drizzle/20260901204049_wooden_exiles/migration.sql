CREATE TABLE "model_telemetry_rollups" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"profile_key" varchar(64) NOT NULL,
	"provider" varchar(128) NOT NULL,
	"transport" varchar(16) NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"calls" integer NOT NULL,
	"errors" integer NOT NULL,
	"tps_p50" real,
	"tps_p95" real,
	"ttft_p50_ms" real,
	"ttft_p95_ms" real,
	"cost_micro_usd" integer NOT NULL,
	"cache_read_ratio" real,
	"sample_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_telemetry_lookup_idx" ON "model_telemetry_rollups" ("profile_key","provider","transport","bucket_start");--> statement-breakpoint
CREATE INDEX "model_telemetry_bucket_idx" ON "model_telemetry_rollups" ("bucket_start");