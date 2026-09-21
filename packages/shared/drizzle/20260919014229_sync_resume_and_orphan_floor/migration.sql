ALTER TABLE "collection_sync_runs" ADD COLUMN "missing_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_sync_runs" ADD COLUMN "legs" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_sync_runs" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "walk_checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "full_resync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "full_resync_reason" text;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "full_resync_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "untracked_scan_cursor" uuid;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "untracked_scan_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_sync_sources" ADD COLUMN "last_full_walk_at" timestamp with time zone;