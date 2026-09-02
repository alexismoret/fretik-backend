ALTER TYPE "tool_approval_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ADD COLUMN "execution_error" text;