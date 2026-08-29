CREATE TABLE "model_alerts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"kind" varchar(32) NOT NULL,
	"severity" varchar(16) DEFAULT 'warning' NOT NULL,
	"model_key" varchar(128),
	"provider" varchar(128),
	"message" text NOT NULL,
	"context" jsonb,
	"notified_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_bench_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"profile_key" varchar(64) NOT NULL,
	"provider" varchar(128) NOT NULL,
	"transport" varchar(16) NOT NULL,
	"metrics" jsonb NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_live_state" (
	"profile_key" varchar(64) PRIMARY KEY,
	"status" varchar(16) DEFAULT 'published' NOT NULL,
	"transport" varchar(16) DEFAULT 'gateway' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" varchar(32),
	"model_ids" jsonb DEFAULT '{}' NOT NULL,
	"provider_pool" jsonb DEFAULT '{}' NOT NULL,
	"quarantined_providers" jsonb DEFAULT '[]' NOT NULL,
	"pool_widened" boolean DEFAULT false NOT NULL,
	"last_resort" boolean DEFAULT false NOT NULL,
	"effective_context_length" integer NOT NULL,
	"effective_max_output" integer,
	"pricing" jsonb NOT NULL,
	"credit_multiplier" real,
	"health" varchar(16) DEFAULT 'unknown' NOT NULL,
	"health_score" real,
	"policy_report" jsonb,
	"policy_fail_streak" integer DEFAULT 0 NOT NULL,
	"endpoint_stats" jsonb,
	"aa_metrics" jsonb,
	"dynamic_profile" jsonb,
	"bound_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"zdr_probe_ok" boolean,
	"zdr_probe_at" timestamp with time zone,
	"source" varchar(16) DEFAULT 'seed' NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_incidents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"model_key" varchar(128) NOT NULL,
	"provider" varchar(128) NOT NULL,
	"transport" varchar(16) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"evidence" jsonb,
	"generation_id" varchar(128),
	"trace_id" varchar(128),
	"role" varchar(48),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"status" varchar(16) NOT NULL,
	"stats" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "model_alerts_recent_idx" ON "model_alerts" ("created_at","acknowledged_at");--> statement-breakpoint
CREATE INDEX "model_bench_lookup_idx" ON "model_bench_runs" ("profile_key","ran_at");--> statement-breakpoint
CREATE INDEX "model_incidents_lookup_idx" ON "model_provider_incidents" ("model_key","provider","kind","created_at");--> statement-breakpoint
--
-- Global infra state, like `worker_cursors`: enable RLS and define NO policy,
-- so the least-privileged `fretik_sql_tool` role the agent queries through can
-- never read model routing, incident evidence or price snapshots. The owner
-- role the services connect as bypasses RLS and is unaffected.
--
ALTER TABLE "model_live_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_provider_incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_bench_runs" ENABLE ROW LEVEL SECURITY;