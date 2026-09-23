CREATE TABLE "decision_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"point" varchar(60) NOT NULL,
	"family" varchar(40) NOT NULL,
	"question_id" varchar(120) NOT NULL,
	"question_version" smallint NOT NULL,
	"subject_type" varchar(40) NOT NULL,
	"subject_id" uuid NOT NULL,
	"target_id" uuid,
	"outcome" varchar(20) NOT NULL,
	"applied" boolean NOT NULL,
	"reason" varchar(40),
	"probability" real,
	"confidence" real,
	"choice" varchar(120),
	"score" real,
	"threshold" real,
	"transport" varchar(20),
	"model_id" varchar(120),
	"latency_ms" integer,
	"cost_usd" real,
	"label" varchar(120),
	"label_source" varchar(20),
	"labeled_by_user_id" uuid,
	"labeled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "decision_log_team_point_created_idx" ON "decision_log" ("team_id","point","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "decision_log_subject_question_uq" ON "decision_log" ("point","subject_id","question_id");--> statement-breakpoint
CREATE INDEX "decision_log_unlabeled_created_idx" ON "decision_log" ("created_at") WHERE "label" IS NULL;--> statement-breakpoint
CREATE INDEX "decision_log_labeled_point_idx" ON "decision_log" ("point","created_at") WHERE "label" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_log" ADD CONSTRAINT "decision_log_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_log" ADD CONSTRAINT "decision_log_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_log" ADD CONSTRAINT "decision_log_labeled_by_user_id_user_id_fkey" FOREIGN KEY ("labeled_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;