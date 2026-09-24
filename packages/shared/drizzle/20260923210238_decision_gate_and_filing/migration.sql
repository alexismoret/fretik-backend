ALTER TYPE "workflow_run_status" ADD VALUE 'not_applicable';--> statement-breakpoint
ALTER TYPE "workflow_run_status" ADD VALUE 'filtered';--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description_source" varchar(10);--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description_document_count" integer;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "gate_decision" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "trigger_criterion" text;