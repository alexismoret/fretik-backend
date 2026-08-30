ALTER TABLE "team_ai_settings" ADD COLUMN "function_profile_keys" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Carry every existing choice over to the function it becomes, BEFORE the
-- columns holding it are dropped below. Without this statement the three DROPs
-- discard every team's model selection in silence.
--
-- `utility_profile_key` fans out to TWO functions, and that is the trap of the
-- whole transition: one stored column has to become two independent picks. A
-- team that chose a cheap model for "utility" was choosing it for its memory
-- writers AND for its quick tasks, so dropping either half would move one of
-- them back to the code default without saying so.
--
-- `recall`, `vision` and `pages` are deliberately left unset: they were never
-- separately selectable, so they start on the code default rather than
-- inheriting a choice nobody made for them.
--
-- `jsonb_strip_nulls` removes the keys whose column was NULL, so a team that
-- customised one tier does not acquire two empty ones.
UPDATE "team_ai_settings"
SET "function_profile_keys" = jsonb_strip_nulls(
  jsonb_build_object(
    'assistant', "flagship_profile_key",
    'documents', "workhorse_profile_key",
    'memory', "utility_profile_key",
    'quick-tasks', "utility_profile_key"
  )
)
WHERE "flagship_profile_key" IS NOT NULL
   OR "workhorse_profile_key" IS NOT NULL
   OR "utility_profile_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "team_ai_settings" DROP COLUMN "flagship_profile_key";--> statement-breakpoint
ALTER TABLE "team_ai_settings" DROP COLUMN "workhorse_profile_key";--> statement-breakpoint
ALTER TABLE "team_ai_settings" DROP COLUMN "utility_profile_key";
