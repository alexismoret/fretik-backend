-- Pages redesign: definitions are now agent-coded (version 3, Vue SFC + data
-- contract). The previous spec/JSONata format has no migration path — the
-- feature never shipped past dev, so dev rows are wiped rather than converted.
DELETE FROM "pages";--> statement-breakpoint
DROP TABLE "page_shares";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "runtime_errors" jsonb DEFAULT '[]' NOT NULL;
