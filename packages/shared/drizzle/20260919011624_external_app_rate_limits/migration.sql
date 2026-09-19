ALTER TABLE "external_app_connections" ADD COLUMN "rate_limit_requests" integer;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "rate_limit_per_seconds" integer;--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "max_concurrent" integer;