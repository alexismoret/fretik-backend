ALTER TABLE "bulk_operations" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bulk_operations" ALTER COLUMN "turn_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_operations_team_hash_uniq" ON "bulk_operations" ("team_id","lookup_hash") WHERE "conversation_id" IS NULL;