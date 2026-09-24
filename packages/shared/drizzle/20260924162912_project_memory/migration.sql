-- A project's own memory: `ai_memories.scope = 'project'`, owned by the
-- project (`project_id`), read by its people in its chats.
--
-- Every pending migration runs in ONE transaction (drizzle's migrator), and
-- Postgres refuses a new enum value as a constant inside the transaction that
-- adds it. So the value is added first, the check compares `scope::text`, and
-- the unique index is keyed on `project_id` (an index predicate may not cast
-- an enum). Expand-only: existing rows are `user` or `team` with no project,
-- which the new check accepts as the old one did.
ALTER TYPE "ai_memory_scope" ADD VALUE 'project';--> statement-breakpoint
ALTER TABLE "ai_memories" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memories_project_path_uq" ON "ai_memories" ("project_id","path") WHERE "project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_memories_project_idx" ON "ai_memories" ("project_id");--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" DROP CONSTRAINT "ai_memories_scope_user_chk", ADD CONSTRAINT "ai_memories_scope_user_chk" CHECK (("scope"::text = 'user' AND "user_id" IS NOT NULL AND "project_id" IS NULL) OR ("scope"::text = 'team' AND "user_id" IS NULL AND "project_id" IS NULL) OR ("scope"::text = 'project' AND "user_id" IS NULL AND "project_id" IS NOT NULL));