ALTER TABLE "skills" ADD COLUMN "source_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "icon_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "catalog_meta" jsonb;