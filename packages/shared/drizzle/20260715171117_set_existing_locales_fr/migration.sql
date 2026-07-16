-- Existing users and teams are French-speaking: default them all to `fr`.
-- Runs once, so it only affects rows present at migration time — new users keep
-- the `user.language` default (`en`) or inherit their inviting team's language,
-- and new teams keep the `team_settings.lang` default (`en`).
UPDATE "user" SET "language" = 'fr';--> statement-breakpoint
UPDATE "team_settings" SET "lang" = 'fr';
