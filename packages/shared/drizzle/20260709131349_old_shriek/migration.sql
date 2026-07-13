ALTER TYPE "workflow_trigger_type" ADD VALUE 'form';--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "form_token" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_form_token_key" UNIQUE("form_token");