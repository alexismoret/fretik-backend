-- Follow-up to the objects -> collections rename: the two identifiers that say
-- "type" where they mean "collection". Split from the previous migration
-- because that one had already been applied.

--> statement-breakpoint
ALTER TABLE "organization_settings"
  RENAME COLUMN "document_mention_target_type_key" TO "document_mention_target_collection_key";
--> statement-breakpoint
ALTER INDEX "action_types_type_key_uniq" RENAME TO "action_types_collection_key_uniq";
