CREATE TYPE "external_app_mcp_auth_kind" AS ENUM('none', 'api-key', 'basic', 'nango-oauth', 'oauth-direct');--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "mcp_auth_kind" "external_app_mcp_auth_kind";--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "mcp_server_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "mcp_api_key_header" varchar(128);--> statement-breakpoint
ALTER TABLE "external_app_connections" ALTER COLUMN "nango_connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "external_app_connections" ALTER COLUMN "nango_provider_config_key" DROP NOT NULL;