CREATE TABLE "changelog_reads" (
	"user_id" uuid,
	"slug" varchar(128),
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changelog_reads_pk" PRIMARY KEY("user_id","slug")
);
--> statement-breakpoint
CREATE INDEX "changelog_reads_slug_idx" ON "changelog_reads" ("slug");--> statement-breakpoint
ALTER TABLE "changelog_reads" ADD CONSTRAINT "changelog_reads_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;