ALTER TABLE "workflow_runs" ADD COLUMN "gate_decision" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "trigger_criterion" text;