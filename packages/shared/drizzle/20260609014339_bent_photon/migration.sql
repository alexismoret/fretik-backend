CREATE TYPE "ai_conversation_member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "ai_conversation_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "ai_conversation_member_role" DEFAULT 'member'::"ai_conversation_member_role" NOT NULL,
	"email_on_completion" boolean DEFAULT false NOT NULL,
	"last_read_at" timestamp,
	"mentioned_at" timestamp,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "author_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_conversation_members" ADD CONSTRAINT "ai_conversation_members_fBomzcRcEkCc_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_conversation_members" ADD CONSTRAINT "ai_conversation_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Backfill: every existing conversation becomes collaborative with its creator
-- as the sole `owner`, carrying over the (soon-to-be-dropped) per-conversation
-- email-on-completion flag as that owner's personal opt-in. Conversations whose
-- creator was deleted (user_id IS NULL) get no member and stay inaccessible.
INSERT INTO "ai_conversation_members" ("conversation_id", "user_id", "role", "email_on_completion", "joined_at", "created_at")
SELECT "id", "user_id", 'owner', "email_on_completion", "created_at", "created_at"
FROM "ai_conversations"
WHERE "user_id" IS NOT NULL;--> statement-breakpoint
-- Backfill: pre-collaboration conversations were single-author, so every stored
-- user message was authored by the conversation creator. Attribute them so
-- historical avatars and speaker labels resolve correctly.
UPDATE "ai_messages" AS m
SET "author_id" = c."user_id"
FROM "ai_conversations" AS c
WHERE m."conversation_id" = c."id"
  AND m."role" = 'user'
  AND c."user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP COLUMN "email_on_completion";--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversation_members_conversation_user_idx" ON "ai_conversation_members" ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_conversation_members_user_idx" ON "ai_conversation_members" ("user_id");--> statement-breakpoint
CREATE INDEX "ai_conversation_members_conversation_idx" ON "ai_conversation_members" ("conversation_id");
