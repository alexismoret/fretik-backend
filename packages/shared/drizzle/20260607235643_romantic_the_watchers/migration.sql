CREATE TABLE "signup_allowed_domains" (
	"domain" varchar PRIMARY KEY,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;