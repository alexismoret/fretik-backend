ALTER TABLE "skills" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_body_max_length" CHECK ("body" IS NULL OR length("body") <= 102400);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_body_required_for_team_uploaded" CHECK ("source" = 'bundled' OR "body" IS NOT NULL);