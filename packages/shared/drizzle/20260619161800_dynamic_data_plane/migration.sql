CREATE TYPE "domain_event_actor" AS ENUM('user', 'agent', 'system', 'connector');--> statement-breakpoint
CREATE TABLE "domain_event_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"event_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"role" varchar(60) DEFAULT 'mentioned' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_type" "domain_event_actor" NOT NULL,
	"actor_user_id" uuid,
	"conversation_id" uuid,
	"subject_type" varchar(60),
	"subject_record_id" uuid,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_key" text
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"link_type_id" uuid NOT NULL,
	"from_record_id" uuid NOT NULL,
	"to_record_id" uuid NOT NULL,
	"props" jsonb DEFAULT '{}' NOT NULL,
	"source" "ontology_source" DEFAULT 'user_manual'::"ontology_source" NOT NULL,
	"confidence" numeric(4,3),
	"source_event_id" uuid,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_by_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"object_type_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"label" text NOT NULL,
	"normalized_label" varchar(300) DEFAULT '' NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"search_vector" tsvector,
	"status" "ontology_status" DEFAULT 'confirmed'::"ontology_status" NOT NULL,
	"source" "ontology_source" DEFAULT 'user_manual'::"ontology_source" NOT NULL,
	"confidence" numeric(4,3),
	"source_event_id" uuid,
	"merged_into_id" uuid,
	"embedding" halfvec(2560),
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_links_uniq" ON "domain_event_links" ("event_id","record_id","role");--> statement-breakpoint
CREATE INDEX "domain_event_links_record_idx" ON "domain_event_links" ("record_id");--> statement-breakpoint
CREATE INDEX "domain_events_team_occurred_idx" ON "domain_events" ("team_id","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_subject_idx" ON "domain_events" ("subject_record_id");--> statement-breakpoint
CREATE INDEX "domain_events_team_type_idx" ON "domain_events" ("team_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_dedup_uniq" ON "domain_events" ("team_id","dedup_key") WHERE dedup_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "links_from_idx" ON "links" ("from_record_id");--> statement-breakpoint
CREATE INDEX "links_to_idx" ON "links" ("to_record_id");--> statement-breakpoint
CREATE INDEX "links_team_type_idx" ON "links" ("team_id","link_type_id");--> statement-breakpoint
CREATE INDEX "links_props_gin_idx" ON "links" USING gin ("props");--> statement-breakpoint
CREATE UNIQUE INDEX "links_active_uniq" ON "links" ("link_type_id","from_record_id","to_record_id") WHERE valid_to IS NULL AND invalidated_at IS NULL;--> statement-breakpoint
CREATE INDEX "object_records_team_type_idx" ON "object_records" ("team_id","object_type_id");--> statement-breakpoint
CREATE INDEX "object_records_team_type_status_idx" ON "object_records" ("team_id","object_type_id","status");--> statement-breakpoint
CREATE INDEX "object_records_data_gin_idx" ON "object_records" USING gin ("data");--> statement-breakpoint
CREATE INDEX "object_records_search_gin_idx" ON "object_records" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "object_records_normalized_label_idx" ON "object_records" ("object_type_id","normalized_label");--> statement-breakpoint
CREATE INDEX "object_records_normalized_label_trgm_idx" ON "object_records" USING gin ("normalized_label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "object_records_aliases_gin_idx" ON "object_records" USING gin ("aliases");--> statement-breakpoint
CREATE UNIQUE INDEX "object_records_document_uniq" ON "object_records" ("document_id") WHERE document_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_event_links" ADD CONSTRAINT "domain_event_links_event_id_domain_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain_event_links" ADD CONSTRAINT "domain_event_links_record_id_object_records_id_fkey" FOREIGN KEY ("record_id") REFERENCES "object_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actor_user_id_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_subject_record_id_object_records_id_fkey" FOREIGN KEY ("subject_record_id") REFERENCES "object_records"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_link_type_id_link_types_id_fkey" FOREIGN KEY ("link_type_id") REFERENCES "link_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_from_record_id_object_records_id_fkey" FOREIGN KEY ("from_record_id") REFERENCES "object_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_to_record_id_object_records_id_fkey" FOREIGN KEY ("to_record_id") REFERENCES "object_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_invalidated_by_link_id_links_id_fkey" FOREIGN KEY ("invalidated_by_link_id") REFERENCES "links"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_object_type_id_object_types_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_merged_into_id_object_records_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "object_records"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "object_records" ADD CONSTRAINT "object_records_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL;