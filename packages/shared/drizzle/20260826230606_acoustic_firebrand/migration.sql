CREATE TYPE "external_app_concurrency_mode" AS ENUM('parallel', 'serial');--> statement-breakpoint
ALTER TABLE "external_app_connections" ADD COLUMN "concurrency_mode" "external_app_concurrency_mode";