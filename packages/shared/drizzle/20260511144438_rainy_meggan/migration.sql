CREATE TYPE "document_status" AS ENUM('converting', 'uploading', 'processing', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "document_type" AS ENUM('invoice', 'credit_note', 'receipt', 'statement', 'contract', 'order', 'quotation', 'certificate', 'permit', 'declaration', 'report', 'letter', 'form', 'list', 'instruction', 'specification', 'plan', 'notice', 'record', 'unknown');--> statement-breakpoint
CREATE TYPE "transport_mode" AS ENUM('sea', 'air', 'road', 'rail', 'inland_waterway', 'multimodal');--> statement-breakpoint
CREATE TYPE "enrichment_status" AS ENUM('pending', 'enriched', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "entity_role" AS ENUM('issuer', 'customer', 'mentioned', 'broker', 'consignee', 'shipper');--> statement-breakpoint
CREATE TYPE "entity_source" AS ENUM('ai_extraction', 'user_manual', 'user_correction');--> statement-breakpoint
CREATE TYPE "entity_status" AS ENUM('confirmed', 'suggested', 'rejected');--> statement-breakpoint
CREATE TYPE "entity_type" AS ENUM('carrier', 'client', 'other');--> statement-breakpoint
CREATE TYPE "activity_action" AS ENUM('upload', 'download', 'delete', 'config_created', 'config_updated', 'folder_created', 'folder_updated', 'folder_deleted', 'label_created', 'label_updated', 'label_deleted', 'export');--> statement-breakpoint
CREATE TYPE "metric_type" AS ENUM('documents_processed', 'storage_gb', 'api_calls');--> statement-breakpoint
CREATE TYPE "resource_type" AS ENUM('document', 'folder', 'label');--> statement-breakpoint
CREATE TYPE "webhook_event" AS ENUM('document.uploaded', 'document.processing', 'document.completed', 'document.failed');--> statement-breakpoint
CREATE TYPE "ai_vector_source_type" AS ENUM('documents', 'memories', 'skills', 'context');--> statement-breakpoint
CREATE TYPE "ai_agent_type" AS ENUM('chatbot');--> statement-breakpoint
CREATE TYPE "ai_message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "ai_chat_file_status" AS ENUM('pending', 'uploading', 'ocr', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "ai_context_file_status" AS ENUM('uploading', 'extracting', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "ai_context_scope" AS ENUM('user', 'team');--> statement-breakpoint
CREATE TYPE "ai_memory_actor" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "ai_memory_scope" AS ENUM('user', 'team');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"team_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"name" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY,
	"storage_quota_gb" integer DEFAULT 100 NOT NULL,
	"max_agencies" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_settings" (
	"team_id" uuid PRIMARY KEY,
	"api_key_hash" text UNIQUE,
	"bot_user_id" uuid NOT NULL,
	"storage_used_gb" numeric(10,4) DEFAULT '0' NOT NULL,
	"lang" varchar(8) DEFAULT 'en' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_labels" (
	"document_id" uuid,
	"label_id" uuid,
	CONSTRAINT "document_labels_pkey" PRIMARY KEY("document_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"parent_folder_id" uuid,
	"name" text NOT NULL,
	"full_path" text NOT NULL,
	"created_by_id" uuid,
	"sub_folder_count" integer DEFAULT 0 NOT NULL,
	"document_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" varchar(7),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_team_name_uniq" UNIQUE("team_id","name")
);
--> statement-breakpoint
CREATE TABLE "document_properties" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"document_id" uuid NOT NULL CONSTRAINT "document_properties_document_id_unique" UNIQUE,
	"markdown" text,
	"page_count" smallint NOT NULL,
	"document_type" "document_type" DEFAULT 'unknown'::"document_type" NOT NULL,
	"document_transport_type" varchar,
	"document_language" varchar(5),
	"document_summary" text NOT NULL,
	"document_date" timestamp with time zone,
	"document_number" varchar(150),
	"transport_mode" "transport_mode",
	"confidence_score" numeric(3,2),
	"pre_extraction_metadata" json,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_transport_types" (
	"code" varchar(100) PRIMARY KEY,
	"icon" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"folder_id" uuid,
	"status" "document_status" DEFAULT 'uploading'::"document_status" NOT NULL,
	"error_message" text,
	"original_filename" varchar NOT NULL,
	"file_size" bigint NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"file_hash" text NOT NULL,
	"s3_key" varchar NOT NULL,
	"s3_thumbnail_key" varchar NOT NULL,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_entities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"document_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" "entity_role" NOT NULL,
	"source" "entity_source" DEFAULT 'ai_extraction'::"entity_source" NOT NULL,
	"confidence" numeric(3,2),
	"raw_extracted_name" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_entities_doc_entity_role_uniq" UNIQUE("document_id","entity_id","role")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"status" "entity_status" DEFAULT 'confirmed'::"entity_status" NOT NULL,
	"type" "entity_type" NOT NULL,
	"name" varchar(200) NOT NULL,
	"normalized_name" varchar(200) NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"image_s3_key" varchar(500),
	"website" varchar(500),
	"address" text,
	"country" varchar(2),
	"phone" varchar(50),
	"email" varchar(200),
	"enrichment_status" "enrichment_status" DEFAULT 'pending'::"enrichment_status",
	"enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_team_normalized_name_uniq" UNIQUE("team_id","normalized_name")
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"action" "activity_action" NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"resource_id" uuid,
	"metadata" json,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_metrics" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"metric_type" "metric_type" NOT NULL,
	"quantity" numeric(15,4) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"team_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_vectors" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"content" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"contextual_prefix" text NOT NULL,
	"chunk_index" smallint NOT NULL,
	"total_chunks" smallint NOT NULL,
	"embedding" halfvec(2560),
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("contextual_prefix", '') || ' ' || coalesce("content", ''))) STORED,
	"source_type" "ai_vector_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"team_id" uuid,
	"organization_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_vectors_scope_consistency" CHECK (("source_type" = 'skills' AND "team_id" IS NULL AND "organization_id" IS NULL AND "user_id" IS NULL) OR ("source_type" = 'context' AND "organization_id" IS NOT NULL) OR ("source_type" NOT IN ('skills', 'context') AND "team_id" IS NOT NULL AND "organization_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_type" "ai_agent_type" DEFAULT 'chatbot'::"ai_agent_type" NOT NULL,
	"title" text NOT NULL,
	"metadata" jsonb,
	"email_on_completion" boolean DEFAULT false NOT NULL,
	"active_stream_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"conversation_id" uuid NOT NULL,
	"role" "ai_message_role" NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_chat_files" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"conversation_id" uuid NOT NULL,
	"document_id" uuid,
	"message_id" uuid,
	"uploaded_by_id" uuid,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size" bigint NOT NULL,
	"has_markdown" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb,
	"status" "ai_chat_file_status" DEFAULT 'pending'::"ai_chat_file_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_chat_files_conversation_filename_unique" UNIQUE("conversation_id","filename")
);
--> statement-breakpoint
CREATE TABLE "ai_context_files" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"profile_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size" bigint NOT NULL,
	"file_hash" text NOT NULL,
	"s3_key" varchar NOT NULL,
	"status" "ai_context_file_status" DEFAULT 'uploading'::"ai_context_file_status" NOT NULL,
	"error_message" text,
	"content" text,
	"char_count" integer,
	"page_count" smallint,
	"has_markdown" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_context_files_profile_filename_unique" UNIQUE("profile_id","filename")
);
--> statement-breakpoint
CREATE TABLE "ai_context_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"scope" "ai_context_scope" NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"instructions" text DEFAULT '' NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_context_profiles_team_org_unique" UNIQUE("team_id","organization_id"),
	CONSTRAINT "ai_context_profiles_user_org_unique" UNIQUE("user_id","organization_id"),
	CONSTRAINT "ai_context_profiles_scope_check" CHECK (("scope" = 'user' AND "user_id" IS NOT NULL AND "team_id" IS NULL) OR ("scope" = 'team' AND "team_id" IS NOT NULL AND "user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ai_context_user_file_mutes" (
	"user_id" uuid,
	"file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_context_user_file_mutes_pk" PRIMARY KEY("user_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "ai_context_user_profile_mutes" (
	"user_id" uuid,
	"profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_context_user_profile_mutes_pk" PRIMARY KEY("user_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "ai_memories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"scope" "ai_memory_scope" NOT NULL,
	"user_id" uuid,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_by_actor" "ai_memory_actor" NOT NULL,
	"created_by_conversation_id" uuid,
	"last_modified_by_user_id" uuid,
	"last_modified_by_actor" "ai_memory_actor" NOT NULL,
	"last_modified_by_conversation_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memories_scope_user_chk" CHECK (("scope" = 'user' AND "user_id" IS NOT NULL) OR ("scope" = 'team' AND "user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ai_memory_history" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"memory_id" uuid,
	"team_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"previous_content" text,
	"new_content" text,
	"previous_path" text,
	"new_path" text,
	"by_user_id" uuid,
	"by_actor" "ai_memory_actor" NOT NULL,
	"by_conversation_id" uuid,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");--> statement-breakpoint
CREATE INDEX "team_organizationId_idx" ON "team" ("organization_id");--> statement-breakpoint
CREATE INDEX "teamMember_teamId_idx" ON "team_member" ("team_id");--> statement-breakpoint
CREATE INDEX "teamMember_userId_idx" ON "team_member" ("user_id");--> statement-breakpoint
CREATE INDEX "document_labels_document_idx" ON "document_labels" ("document_id");--> statement-breakpoint
CREATE INDEX "document_labels_label_idx" ON "document_labels" ("label_id");--> statement-breakpoint
CREATE INDEX "folders_team_idx" ON "folders" ("team_id");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" ("parent_folder_id");--> statement-breakpoint
CREATE INDEX "folders_full_path_idx" ON "folders" ("full_path");--> statement-breakpoint
CREATE INDEX "labels_team_idx" ON "labels" ("team_id");--> statement-breakpoint
CREATE INDEX "documents_team_idx" ON "documents" ("team_id");--> statement-breakpoint
CREATE INDEX "documents_folder_idx" ON "documents" ("folder_id");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" ("created_at");--> statement-breakpoint
CREATE INDEX "documents_file_hash_idx" ON "documents" ("file_hash");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" ("status");--> statement-breakpoint
CREATE INDEX "document_entities_document_idx" ON "document_entities" ("document_id");--> statement-breakpoint
CREATE INDEX "document_entities_entity_idx" ON "document_entities" ("entity_id");--> statement-breakpoint
CREATE INDEX "entities_team_idx" ON "entities" ("team_id");--> statement-breakpoint
CREATE INDEX "entities_team_status_idx" ON "entities" ("team_id","status");--> statement-breakpoint
CREATE INDEX "activity_logs_team_idx" ON "activity_logs" ("team_id");--> statement-breakpoint
CREATE INDEX "activity_logs_user_idx" ON "activity_logs" ("user_id");--> statement-breakpoint
CREATE INDEX "activity_logs_action_idx" ON "activity_logs" ("action");--> statement-breakpoint
CREATE INDEX "activity_logs_resource_idx" ON "activity_logs" ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "activity_logs_created_at_idx" ON "activity_logs" ("created_at");--> statement-breakpoint
CREATE INDEX "usage_metrics_org_idx" ON "usage_metrics" ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_metrics_team_idx" ON "usage_metrics" ("team_id");--> statement-breakpoint
CREATE INDEX "usage_metrics_type_idx" ON "usage_metrics" ("metric_type");--> statement-breakpoint
CREATE INDEX "usage_metrics_period_idx" ON "usage_metrics" ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "usage_metrics_org_period_idx" ON "usage_metrics" ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "webhooks_team_idx" ON "webhooks" ("team_id");--> statement-breakpoint
CREATE INDEX "webhooks_active_idx" ON "webhooks" ("is_active");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_team_id" ON "ai_vectors" ("team_id");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_organization_id" ON "ai_vectors" ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_source" ON "ai_vectors" ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_team_created" ON "ai_vectors" ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_metadata_gin" ON "ai_vectors" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_search_vector" ON "ai_vectors" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_embedding_hnsw" ON "ai_vectors" USING hnsw ("embedding" halfvec_cosine_ops) WITH (m=16, ef_construction=200);--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_team_user_partial" ON "ai_vectors" ("team_id","user_id") WHERE source_type IN ('memories', 'context');--> statement-breakpoint
CREATE INDEX "idx_ai_vectors_global" ON "ai_vectors" ("source_type") WHERE team_id IS NULL;--> statement-breakpoint
CREATE INDEX "ai_conversations_team_idx" ON "ai_conversations" ("team_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" ("user_id");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_created_idx" ON "ai_messages" ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_chat_files_conversation_created_idx" ON "ai_chat_files" ("conversation_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "ai_chat_files_orphans_idx" ON "ai_chat_files" ("conversation_id","message_id") WHERE "message_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ai_chat_files_error_idx" ON "ai_chat_files" ("status") WHERE "status" = 'error';--> statement-breakpoint
CREATE INDEX "ai_context_files_profile_enabled_idx" ON "ai_context_files" ("profile_id","enabled");--> statement-breakpoint
CREATE INDEX "ai_context_files_hash_idx" ON "ai_context_files" ("file_hash");--> statement-breakpoint
CREATE INDEX "ai_context_files_error_idx" ON "ai_context_files" ("status") WHERE "status" = 'error';--> statement-breakpoint
CREATE INDEX "ai_context_profiles_team_idx" ON "ai_context_profiles" ("team_id","organization_id");--> statement-breakpoint
CREATE INDEX "ai_context_profiles_user_idx" ON "ai_context_profiles" ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "ai_context_user_file_mutes_user_idx" ON "ai_context_user_file_mutes" ("user_id");--> statement-breakpoint
CREATE INDEX "ai_context_user_profile_mutes_user_idx" ON "ai_context_user_profile_mutes" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memories_user_path_uq" ON "ai_memories" ("team_id","user_id","path") WHERE "scope" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memories_team_path_uq" ON "ai_memories" ("team_id","path") WHERE "scope" = 'team';--> statement-breakpoint
CREATE INDEX "ai_memories_team_idx" ON "ai_memories" ("team_id");--> statement-breakpoint
CREATE INDEX "ai_memories_team_user_idx" ON "ai_memories" ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_memories_content_trgm_idx" ON "ai_memories" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ai_memory_history_memory_idx" ON "ai_memory_history" ("memory_id");--> statement-breakpoint
CREATE INDEX "ai_memory_history_team_idx" ON "ai_memory_history" ("team_id");--> statement-breakpoint
CREATE INDEX "ai_memory_history_team_created_idx" ON "ai_memory_history" ("team_id","created_at");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_settings" ADD CONSTRAINT "team_settings_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_settings" ADD CONSTRAINT "team_settings_bot_user_id_user_id_fkey" FOREIGN KEY ("bot_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "document_labels" ADD CONSTRAINT "document_labels_label_id_labels_id_fkey" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_folders_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_properties" ADD CONSTRAINT "document_properties_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_properties" ADD CONSTRAINT "document_properties_yKNHiAhWqG9O_fkey" FOREIGN KEY ("document_transport_type") REFERENCES "document_transport_types"("code") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_user_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "document_entities" ADD CONSTRAINT "document_entities_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_entities" ADD CONSTRAINT "document_entities_entity_id_entities_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "usage_metrics" ADD CONSTRAINT "usage_metrics_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_metrics" ADD CONSTRAINT "usage_metrics_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_vectors" ADD CONSTRAINT "ai_vectors_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_vectors" ADD CONSTRAINT "ai_vectors_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_vectors" ADD CONSTRAINT "ai_vectors_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_chat_files" ADD CONSTRAINT "ai_chat_files_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_chat_files" ADD CONSTRAINT "ai_chat_files_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_chat_files" ADD CONSTRAINT "ai_chat_files_message_id_ai_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_chat_files" ADD CONSTRAINT "ai_chat_files_uploaded_by_id_user_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_context_files" ADD CONSTRAINT "ai_context_files_profile_id_ai_context_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ai_context_profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_files" ADD CONSTRAINT "ai_context_files_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_files" ADD CONSTRAINT "ai_context_files_uploaded_by_id_user_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_context_profiles" ADD CONSTRAINT "ai_context_profiles_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_profiles" ADD CONSTRAINT "ai_context_profiles_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_profiles" ADD CONSTRAINT "ai_context_profiles_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_profiles" ADD CONSTRAINT "ai_context_profiles_updated_by_id_user_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_context_user_file_mutes" ADD CONSTRAINT "ai_context_user_file_mutes_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_user_file_mutes" ADD CONSTRAINT "ai_context_user_file_mutes_file_id_ai_context_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "ai_context_files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_user_profile_mutes" ADD CONSTRAINT "ai_context_user_profile_mutes_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_context_user_profile_mutes" ADD CONSTRAINT "ai_context_user_profile_mutes_YN8pBnKAVJVd_fkey" FOREIGN KEY ("profile_id") REFERENCES "ai_context_profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_created_by_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("created_by_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_last_modified_by_user_id_user_id_fkey" FOREIGN KEY ("last_modified_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_5QwcJhQHlPxb_fkey" FOREIGN KEY ("last_modified_by_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memory_history" ADD CONSTRAINT "ai_memory_history_memory_id_ai_memories_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "ai_memories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memory_history" ADD CONSTRAINT "ai_memory_history_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memory_history" ADD CONSTRAINT "ai_memory_history_by_user_id_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memory_history" ADD CONSTRAINT "ai_memory_history_by_conversation_id_ai_conversations_id_fkey" FOREIGN KEY ("by_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL;
-- ============================================================================
-- Seed: document_transport_types (45 codes)
-- ============================================================================
INSERT INTO "document_transport_types" ("code", "icon") VALUES
  ('air_waybill', 'i-lucide-plane'),
  ('arrival_notice', 'i-lucide-bell'),
  ('bill_of_lading', 'i-lucide-ship'),
  ('booking_document', 'i-lucide-calendar-check'),
  ('cargo_insurance_certificate', 'i-lucide-shield'),
  ('cargo_manifest', 'i-lucide-file-text'),
  ('certificate_of_origin', 'i-lucide-award'),
  ('charter_party', 'i-lucide-anchor'),
  ('commercial_invoice_transport', 'i-lucide-file-text'),
  ('container_interchange_document', 'i-lucide-arrow-right-left'),
  ('container_list', 'i-lucide-container'),
  ('customs_declaration', 'i-lucide-stamp'),
  ('customs_invoice', 'i-lucide-file-text'),
  ('customs_valuation_document', 'i-lucide-calculator'),
  ('damage_report', 'i-lucide-alert-triangle'),
  ('dangerous_goods_declaration', 'i-lucide-alert-octagon'),
  ('delivery_document', 'i-lucide-package-check'),
  ('equipment_release', 'i-lucide-package-minus'),
  ('export_license', 'i-lucide-file-badge'),
  ('freight_invoice', 'i-lucide-receipt'),
  ('fumigation_certificate', 'i-lucide-spray-can'),
  ('guarantee_document', 'i-lucide-handshake'),
  ('health_certificate', 'i-lucide-shield-check'),
  ('inland_waterway_bill', 'i-lucide-ship'),
  ('inspection_certificate', 'i-lucide-search-check'),
  ('insurance_declaration', 'i-lucide-shield-alert'),
  ('letter_of_credit', 'i-lucide-credit-card'),
  ('loading_list', 'i-lucide-package'),
  ('msds', 'i-lucide-file-warning'),
  ('multimodal_transport_document', 'i-lucide-route'),
  ('packing_list', 'i-lucide-package-open'),
  ('rail_consignment_note', 'i-lucide-train'),
  ('rate_document', 'i-lucide-tag'),
  ('release_order', 'i-lucide-unlock'),
  ('road_consignment_note', 'i-lucide-truck'),
  ('schedule', 'i-lucide-calendar-clock'),
  ('sea_waybill', 'i-lucide-ship'),
  ('shipping_instruction', 'i-lucide-clipboard-list'),
  ('special_instruction', 'i-lucide-file-warning'),
  ('storage_document', 'i-lucide-archive'),
  ('summary_declaration', 'i-lucide-file-check'),
  ('temporary_import_document', 'i-lucide-rotate-ccw'),
  ('tracking_report', 'i-lucide-route'),
  ('transport_order', 'i-lucide-clipboard-copy'),
  ('vgm_declaration', 'i-lucide-scale'),
  ('warehouse_receipt', 'i-lucide-warehouse')
ON CONFLICT (code) DO NOTHING;
