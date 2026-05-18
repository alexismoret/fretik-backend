CREATE TYPE "field_definition_resource_type" AS ENUM('document');--> statement-breakpoint
CREATE TYPE "field_definition_type" AS ENUM('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email');--> statement-breakpoint
CREATE TYPE "document_field_value_source" AS ENUM('ai_extraction', 'user_manual', 'user_correction', 'template_default');--> statement-breakpoint
CREATE TABLE "field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"resource_type" "field_definition_resource_type" DEFAULT 'document'::"field_definition_resource_type" NOT NULL,
	"key" varchar(60) NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"type" "field_definition_type" NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"ai_extraction_enabled" boolean DEFAULT true NOT NULL,
	"vectorize_include" boolean DEFAULT true NOT NULL,
	"display_in_panel" boolean DEFAULT true NOT NULL,
	"display_in_filters" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_field_values" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"document_id" uuid NOT NULL,
	"field_key" varchar(60) NOT NULL,
	"value" jsonb NOT NULL,
	"source" "document_field_value_source" DEFAULT 'ai_extraction'::"document_field_value_source" NOT NULL,
	"confidence" numeric(3,2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_properties" DROP CONSTRAINT "document_properties_yKNHiAhWqG9O_fkey";--> statement-breakpoint
DROP TABLE "document_transport_types";--> statement-breakpoint
ALTER TABLE "document_properties" DROP COLUMN "document_type";--> statement-breakpoint
ALTER TABLE "document_properties" DROP COLUMN "document_transport_type";--> statement-breakpoint
ALTER TABLE "document_properties" DROP COLUMN "document_date";--> statement-breakpoint
ALTER TABLE "document_properties" DROP COLUMN "document_number";--> statement-breakpoint
ALTER TABLE "document_properties" DROP COLUMN "transport_mode";--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_org_key_uniq" ON "field_definitions" ("organization_id","resource_type","key") WHERE team_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_team_key_uniq" ON "field_definitions" ("team_id","resource_type","key") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "field_definitions_org_resource_idx" ON "field_definitions" ("organization_id","resource_type") WHERE team_id IS NULL;--> statement-breakpoint
CREATE INDEX "field_definitions_team_resource_idx" ON "field_definitions" ("team_id","resource_type") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_field_values_doc_key_uniq" ON "document_field_values" ("document_id","field_key");--> statement-breakpoint
CREATE INDEX "document_field_values_field_key_idx" ON "document_field_values" ("field_key","value");--> statement-breakpoint
CREATE INDEX "document_field_values_value_gin_idx" ON "document_field_values" USING gin ("value");--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_field_values" ADD CONSTRAINT "document_field_values_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
DROP TYPE "document_type";--> statement-breakpoint
DROP TYPE "transport_mode";