CREATE TABLE "model_admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"user_id" uuid,
	"action" varchar(32) NOT NULL,
	"profile_key" varchar(64),
	"outcome" varchar(32) NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_admin_actions_recent_idx" ON "model_admin_actions" ("created_at");--> statement-breakpoint
CREATE INDEX "model_admin_actions_model_idx" ON "model_admin_actions" ("profile_key","created_at");--> statement-breakpoint
CREATE INDEX "model_admin_actions_user_idx" ON "model_admin_actions" ("user_id");--> statement-breakpoint
ALTER TABLE "model_admin_actions" ADD CONSTRAINT "model_admin_actions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
--
-- Hand-written, because drizzle-kit does not emit RLS.
--
-- Same stance as every other `model_*` table (see `blushing_ultragirl`):
-- global infra state, RLS enabled with NO policy, so the least-privileged
-- `fretik_sql_tool` role the agent queries through can never read it. The
-- owner role the services connect as bypasses RLS and is unaffected.
--
-- It matters MORE here than for its neighbours: this table joins operator
-- USER IDS to model routing decisions, so a leak would be both an identity
-- disclosure and an infrastructure one.
--
ALTER TABLE "model_admin_actions" ENABLE ROW LEVEL SECURITY;