ALTER TABLE "workflow_runs" ADD COLUMN "resume_from_turn_index" integer;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "resume_remaining_ms" integer;