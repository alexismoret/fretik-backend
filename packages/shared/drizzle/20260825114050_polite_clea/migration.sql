CREATE TYPE "user_pin_target" AS ENUM('collection', 'page');--> statement-breakpoint
CREATE TABLE "user_pins" (
	"user_id" uuid,
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"target_type" "user_pin_target",
	"target_id" uuid,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_pins_pk" PRIMARY KEY("user_id","team_id","target_type","target_id")
);
--> statement-breakpoint
CREATE INDEX "user_pins_target_idx" ON "user_pins" ("target_type","target_id");--> statement-breakpoint
ALTER TABLE "user_pins" ADD CONSTRAINT "user_pins_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_pins" ADD CONSTRAINT "user_pins_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_pins" ADD CONSTRAINT "user_pins_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;