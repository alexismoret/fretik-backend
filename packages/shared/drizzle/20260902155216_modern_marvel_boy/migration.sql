CREATE TABLE "release_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"name" varchar(64) NOT NULL,
	"version" varchar(64) NOT NULL,
	"service" varchar(8) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"detail" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "release_tasks_name_version_idx" ON "release_tasks" ("name","version");--> statement-breakpoint
CREATE INDEX "release_tasks_recent_idx" ON "release_tasks" ("started_at");