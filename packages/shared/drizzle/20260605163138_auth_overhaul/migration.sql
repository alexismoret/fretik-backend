CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_allowlist" (
	"email" varchar PRIMARY KEY,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"user_id" uuid,
	"event" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" ("user_id");--> statement-breakpoint
CREATE INDEX "authAuditLog_userId_idx" ON "auth_audit_log" ("user_id");--> statement-breakpoint
CREATE INDEX "authAuditLog_event_idx" ON "auth_audit_log" ("event");--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_audit_log" ADD CONSTRAINT "auth_audit_log_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;