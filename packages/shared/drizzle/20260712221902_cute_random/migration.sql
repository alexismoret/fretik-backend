ALTER TABLE "skills" ADD COLUMN "source_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_skipped_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "mcp_transport" varchar(16);