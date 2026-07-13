CREATE TYPE "ontology_source" AS ENUM('user_manual', 'user_correction', 'ai_extraction', 'ai_inference', 'system', 'connector');--> statement-breakpoint
CREATE TYPE "ontology_status" AS ENUM('confirmed', 'suggested', 'rejected');--> statement-breakpoint
CREATE TYPE "link_type_cardinality" AS ENUM('one_to_one', 'one_to_many', 'many_to_many');--> statement-breakpoint
CREATE TABLE "object_types" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"key" varchar(60) NOT NULL,
	"label" text NOT NULL,
	"label_plural" text,
	"description" text,
	"icon" varchar(60),
	"color" varchar(20),
	"is_system" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_types" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"key" varchar(60) NOT NULL,
	"normalized_key" varchar(60) NOT NULL,
	"label" text NOT NULL,
	"from_object_type_id" uuid NOT NULL,
	"to_object_type_id" uuid,
	"inverse_key" varchar(60),
	"inverse_label" text,
	"cardinality" "link_type_cardinality" DEFAULT 'many_to_many'::"link_type_cardinality" NOT NULL,
	"is_temporal" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" "ontology_status" DEFAULT 'confirmed'::"ontology_status" NOT NULL,
	"source" "ontology_source" DEFAULT 'user_manual'::"ontology_source" NOT NULL,
	"confidence" numeric(4,3),
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_types" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"object_type_id" uuid NOT NULL,
	"key" varchar(60) NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"input_schema" jsonb DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "object_types" ADD CONSTRAINT "object_types_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "object_types" ADD CONSTRAINT "object_types_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "link_types" ADD CONSTRAINT "link_types_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "link_types" ADD CONSTRAINT "link_types_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "link_types" ADD CONSTRAINT "link_types_from_object_type_id_object_types_id_fkey" FOREIGN KEY ("from_object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "link_types" ADD CONSTRAINT "link_types_to_object_type_id_object_types_id_fkey" FOREIGN KEY ("to_object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "link_types" ADD CONSTRAINT "link_types_merged_into_id_link_types_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "link_types"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "action_types" ADD CONSTRAINT "action_types_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "action_types" ADD CONSTRAINT "action_types_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "action_types" ADD CONSTRAINT "action_types_object_type_id_object_types_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "object_types_org_key_uniq" ON "object_types" ("organization_id","key") WHERE team_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "object_types_team_key_uniq" ON "object_types" ("team_id","key") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "object_types_org_idx" ON "object_types" ("organization_id");--> statement-breakpoint
CREATE INDEX "object_types_team_idx" ON "object_types" ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_types_org_key_uniq" ON "link_types" ("organization_id","normalized_key") WHERE team_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "link_types_team_key_uniq" ON "link_types" ("team_id","normalized_key") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "link_types_org_idx" ON "link_types" ("organization_id");--> statement-breakpoint
CREATE INDEX "link_types_team_idx" ON "link_types" ("team_id");--> statement-breakpoint
CREATE INDEX "link_types_from_idx" ON "link_types" ("from_object_type_id");--> statement-breakpoint
CREATE INDEX "link_types_to_idx" ON "link_types" ("to_object_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_types_type_key_uniq" ON "action_types" ("object_type_id","key");--> statement-breakpoint
CREATE INDEX "action_types_org_idx" ON "action_types" ("organization_id");--> statement-breakpoint
CREATE INDEX "action_types_team_idx" ON "action_types" ("team_id");--> statement-breakpoint
-- Seed the standard object types for every existing organization. Generic
-- business primitives only — no industry specifics, no relations (link types
-- are created on demand). New orgs get these (plus default fields) from the
-- org-creation hook (seedSystemOntology). All are user-editable/deletable
-- except `document`, which the delete service protects.
INSERT INTO "object_types" ("organization_id", "team_id", "key", "label", "label_plural", "is_system", "icon")
SELECT o."id", NULL, seed."key", seed."label", seed."label_plural", true, seed."icon"
FROM "organization" o
CROSS JOIN (VALUES
	('document', 'Document', 'Documents', 'file-text'),
	('company', 'Company', 'Companies', 'building-2'),
	('person', 'Person', 'People', 'user'),
	('note', 'Note', 'Notes', 'sticky-note'),
	('task', 'Task', 'Tasks', 'circle-check')
) AS seed("key", "label", "label_plural", "icon")
ON CONFLICT ("organization_id", "key") WHERE team_id IS NULL DO NOTHING;--> statement-breakpoint
DROP INDEX "field_definitions_org_resource_idx";--> statement-breakpoint
DROP INDEX "field_definitions_team_resource_idx";--> statement-breakpoint
-- The two *_key_uniq indexes include resource_type, so dropping that column
-- would auto-drop them. Drop them explicitly NOW (before the column drop) so a
-- later DROP INDEX can't fail on an already-removed index. Recreated below on
-- (object_type_id, key).
DROP INDEX "field_definitions_org_key_uniq";--> statement-breakpoint
DROP INDEX "field_definitions_team_key_uniq";--> statement-breakpoint
-- Add object_type_id as NULLABLE first so existing rows survive, then backfill.
ALTER TABLE "field_definitions" ADD COLUMN "object_type_id" uuid;--> statement-breakpoint
ALTER TABLE "field_definitions" ADD COLUMN "is_title" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: every existing field definition is a document field → point it at
-- its org's system document object type.
UPDATE "field_definitions" fd
SET "object_type_id" = (
	SELECT ot."id" FROM "object_types" ot
	WHERE ot."organization_id" = fd."organization_id" AND ot."key" = 'document' AND ot."team_id" IS NULL
)
WHERE fd."object_type_id" IS NULL;--> statement-breakpoint
ALTER TABLE "field_definitions" ALTER COLUMN "object_type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_object_type_id_object_types_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "field_definitions" DROP COLUMN "resource_type";--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_org_key_uniq" ON "field_definitions" ("object_type_id","key") WHERE team_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_team_key_uniq" ON "field_definitions" ("team_id","object_type_id","key") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_org_title_uniq" ON "field_definitions" ("object_type_id") WHERE is_title AND team_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_team_title_uniq" ON "field_definitions" ("team_id","object_type_id") WHERE is_title AND team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "field_definitions_object_type_idx" ON "field_definitions" ("object_type_id");--> statement-breakpoint
CREATE INDEX "field_definitions_team_object_type_idx" ON "field_definitions" ("team_id","object_type_id") WHERE team_id IS NOT NULL;--> statement-breakpoint
DROP TYPE "field_definition_resource_type";
