ALTER TYPE "field_definition_type" ADD VALUE 'relation';--> statement-breakpoint
ALTER TYPE "field_definition_type" ADD VALUE 'member';--> statement-breakpoint
ALTER TYPE "field_definition_type" ADD VALUE 'money';--> statement-breakpoint
ALTER TYPE "field_definition_type" ADD VALUE 'markdown';--> statement-breakpoint
ALTER TYPE "field_definition_type" ADD VALUE 'rating';--> statement-breakpoint
ALTER TYPE "field_definition_type" ADD VALUE 'phone';--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "document_mention_target_type_key" varchar(60);--> statement-breakpoint
ALTER TABLE "object_records" ADD COLUMN "created_by_actor" "domain_event_actor";--> statement-breakpoint
ALTER TABLE "object_records" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "object_records" ADD COLUMN "updated_by_actor" "domain_event_actor";--> statement-breakpoint
ALTER TABLE "object_records" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_updated_by_user_id_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;