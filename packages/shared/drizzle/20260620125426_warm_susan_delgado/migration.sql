ALTER TABLE "document_entities" DROP CONSTRAINT "document_entities_entity_id_entities_id_fkey";--> statement-breakpoint
DROP TABLE "document_field_values";--> statement-breakpoint
DROP TABLE "document_entities";--> statement-breakpoint
DROP TABLE "entities";--> statement-breakpoint
DROP TYPE "document_field_value_source";--> statement-breakpoint
DROP TYPE "enrichment_status";--> statement-breakpoint
DROP TYPE "entity_role";--> statement-breakpoint
DROP TYPE "entity_source";--> statement-breakpoint
DROP TYPE "entity_status";--> statement-breakpoint
DROP TYPE "entity_type";--> statement-breakpoint
-- Seed the generic system `mentions` link type for every existing org that has
-- the seeded `document` object type but no `mentions` relation yet (new orgs get
-- it from `seedSystemOntology`). The document pipeline links extracted parties
-- to `company` records via this relation; without it the fold skips linking.
INSERT INTO "link_types" (
  "organization_id", "team_id", "key", "normalized_key", "label",
  "from_object_type_id", "to_object_type_id", "inverse_key", "inverse_label", "source"
)
SELECT
  ot."organization_id", NULL, 'mentions', 'mentions', 'Mentions',
  ot."id", NULL, 'mentioned_in', 'Mentioned in', 'system'
FROM "object_types" ot
WHERE ot."team_id" IS NULL AND ot."key" = 'document'
  AND NOT EXISTS (
    SELECT 1 FROM "link_types" lt
    WHERE lt."organization_id" = ot."organization_id"
      AND lt."team_id" IS NULL
      AND lt."normalized_key" = 'mentions'
  );