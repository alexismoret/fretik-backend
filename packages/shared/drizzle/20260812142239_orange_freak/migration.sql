ALTER TABLE "workflow_runs" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "paused_ms" integer DEFAULT 0 NOT NULL;