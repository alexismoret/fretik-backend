ALTER TABLE "folders" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description_source" varchar(10);--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "description_document_count" integer;