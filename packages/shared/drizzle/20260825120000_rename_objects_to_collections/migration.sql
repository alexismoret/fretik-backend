-- Rename the `objects` feature to `collections`.
-- Purely nominal: no column is added, dropped or retyped, and no row moves.
-- Hand-written because drizzle-kit renders a rename as DROP + CREATE, which
-- would rebuild the GIN/trgm indexes on collection_records and lose the data.

--> statement-breakpoint
ALTER TYPE "object_permission" RENAME TO "collection_permission";
--> statement-breakpoint
ALTER TABLE "object_types" RENAME TO "collections";
--> statement-breakpoint
ALTER TABLE "object_records" RENAME TO "collection_records";
--> statement-breakpoint
ALTER TABLE "object_grants" RENAME TO "collection_grants";
--> statement-breakpoint

-- Columns. Policy quals, generated expressions and index definitions are
-- stored parsed, so Postgres rewrites them here for free.
ALTER TABLE "collection_records" RENAME COLUMN "object_type_id" TO "collection_id";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME COLUMN "object_type_id" TO "collection_id";
--> statement-breakpoint
ALTER TABLE "field_definitions" RENAME COLUMN "object_type_id" TO "collection_id";
--> statement-breakpoint
ALTER TABLE "action_types" RENAME COLUMN "object_type_id" TO "collection_id";
--> statement-breakpoint
ALTER TABLE "link_types" RENAME COLUMN "from_object_type_id" TO "from_collection_id";
--> statement-breakpoint
ALTER TABLE "link_types" RENAME COLUMN "to_object_type_id" TO "to_collection_id";
--> statement-breakpoint

-- Constraints. RENAME is catalog-only; DROP + ADD would revalidate every FK
-- under an ACCESS EXCLUSIVE lock. Names must match what drizzle derives, or
-- the next `db:generate` diffs against a snapshot that lies about the DB.
ALTER TABLE "action_types" RENAME CONSTRAINT "action_types_object_type_id_object_types_id_fkey" TO "action_types_collection_id_collections_id_fkey";
--> statement-breakpoint
ALTER TABLE "ai_episode_records" RENAME CONSTRAINT "ai_episode_records_record_id_object_records_id_fkey" TO "ai_episode_records_record_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "ai_episodes" RENAME CONSTRAINT "ai_episodes_anchor_record_id_object_records_id_fkey" TO "ai_episodes_anchor_record_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "domain_event_links" RENAME CONSTRAINT "domain_event_links_record_id_object_records_id_fkey" TO "domain_event_links_record_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "domain_events" RENAME CONSTRAINT "domain_events_subject_record_id_object_records_id_fkey" TO "domain_events_subject_record_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "field_definitions" RENAME CONSTRAINT "field_definitions_object_type_id_object_types_id_fkey" TO "field_definitions_collection_id_collections_id_fkey";
--> statement-breakpoint
ALTER TABLE "link_types" RENAME CONSTRAINT "link_types_from_object_type_id_object_types_id_fkey" TO "link_types_from_collection_id_collections_id_fkey";
--> statement-breakpoint
ALTER TABLE "link_types" RENAME CONSTRAINT "link_types_to_object_type_id_object_types_id_fkey" TO "link_types_to_collection_id_collections_id_fkey";
--> statement-breakpoint
ALTER TABLE "links" RENAME CONSTRAINT "links_from_record_id_object_records_id_fkey" TO "links_from_record_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "links" RENAME CONSTRAINT "links_to_record_id_object_records_id_fkey" TO "links_to_record_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME CONSTRAINT "object_grants_created_by_user_id_user_id_fkey" TO "collection_grants_created_by_user_id_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME CONSTRAINT "object_grants_grantee_team_id_team_id_fkey" TO "collection_grants_grantee_team_id_team_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME CONSTRAINT "object_grants_object_type_id_object_types_id_fkey" TO "collection_grants_collection_id_collections_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME CONSTRAINT "object_grants_organization_id_organization_id_fkey" TO "collection_grants_organization_id_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME CONSTRAINT "object_grants_owner_team_id_team_id_fkey" TO "collection_grants_owner_team_id_team_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_grants" RENAME CONSTRAINT "object_grants_pkey" TO "collection_grants_pkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_created_by_user_id_user_id_fkey" TO "collection_records_created_by_user_id_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_document_id_documents_id_fkey" TO "collection_records_document_id_documents_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_merged_into_id_object_records_id_fkey" TO "collection_records_merged_into_id_collection_records_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_object_type_id_object_types_id_fkey" TO "collection_records_collection_id_collections_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_organization_id_organization_id_fkey" TO "collection_records_organization_id_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_pkey" TO "collection_records_pkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_team_id_team_id_fkey" TO "collection_records_team_id_team_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_updated_by_user_id_user_id_fkey" TO "collection_records_updated_by_user_id_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "collection_records" RENAME CONSTRAINT "object_records_user_id_user_id_fkey" TO "collection_records_user_id_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "collections" RENAME CONSTRAINT "object_types_organization_id_organization_id_fkey" TO "collections_organization_id_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "collections" RENAME CONSTRAINT "object_types_pkey" TO "collections_pkey";
--> statement-breakpoint
ALTER TABLE "collections" RENAME CONSTRAINT "object_types_team_id_team_id_fkey" TO "collections_team_id_team_id_fkey";
--> statement-breakpoint
ALTER TABLE "record_shares" RENAME CONSTRAINT "record_shares_record_id_object_records_id_fkey" TO "record_shares_record_id_collection_records_id_fkey";
--> statement-breakpoint

-- Indexes not backed by a constraint (the pkey indexes followed their
-- constraint above).
ALTER INDEX "field_definitions_object_type_idx" RENAME TO "field_definitions_collection_idx";
--> statement-breakpoint
ALTER INDEX "field_definitions_team_object_type_idx" RENAME TO "field_definitions_team_collection_idx";
--> statement-breakpoint
ALTER INDEX "object_grants_grantee_idx" RENAME TO "collection_grants_grantee_idx";
--> statement-breakpoint
ALTER INDEX "object_grants_type_grantee_uniq" RENAME TO "collection_grants_type_grantee_uniq";
--> statement-breakpoint
ALTER INDEX "object_grants_type_idx" RENAME TO "collection_grants_type_idx";
--> statement-breakpoint
ALTER INDEX "object_grants_type_orgwide_uniq" RENAME TO "collection_grants_type_orgwide_uniq";
--> statement-breakpoint
ALTER INDEX "object_records_aliases_gin_idx" RENAME TO "collection_records_aliases_gin_idx";
--> statement-breakpoint
ALTER INDEX "object_records_document_uniq" RENAME TO "collection_records_document_uniq";
--> statement-breakpoint
ALTER INDEX "object_records_normalized_label_idx" RENAME TO "collection_records_normalized_label_idx";
--> statement-breakpoint
ALTER INDEX "object_records_normalized_label_trgm_idx" RENAME TO "collection_records_normalized_label_trgm_idx";
--> statement-breakpoint
ALTER INDEX "object_records_search_gin_idx" RENAME TO "collection_records_search_gin_idx";
--> statement-breakpoint
ALTER INDEX "object_records_team_type_idx" RENAME TO "collection_records_team_type_idx";
--> statement-breakpoint
ALTER INDEX "object_records_team_type_status_idx" RENAME TO "collection_records_team_type_status_idx";
--> statement-breakpoint
ALTER INDEX "object_types_org_idx" RENAME TO "collections_org_idx";
--> statement-breakpoint
ALTER INDEX "object_types_org_key_uniq" RENAME TO "collections_org_key_uniq";
--> statement-breakpoint
ALTER INDEX "object_types_team_idx" RENAME TO "collections_team_idx";
--> statement-breakpoint
ALTER INDEX "object_types_team_key_uniq" RENAME TO "collections_team_key_uniq";
--> statement-breakpoint

-- RLS helper functions. Their bodies are STRINGS re-parsed at execution, so
-- they do NOT follow the renames above: left alone they would keep pointing
-- at object_grants / object_records and fail at query time, not here.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.fretik_type_granted(p_type uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
      SELECT 1 FROM collection_grants g
      WHERE g.collection_id = p_type
        AND g.organization_id = fretik_org()
        AND (g.grantee_team_id = fretik_team() OR g.grantee_team_id IS NULL)
    )
  $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.fretik_record_visible(p_record uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
      SELECT 1 FROM collection_records r
      WHERE r.id = p_record
        AND r.inherit_type_sharing
        AND fretik_type_granted(r.collection_id)
    ) OR fretik_record_shared(p_record)
  $function$;
--> statement-breakpoint

-- Per-collection physical tables: data.obj_<hex> -> data.coll_<hex>.
-- Their RLS policies, `ix_*` indexes and `seq_*` sequences carry no prefix
-- and ride the rename; the implicit pkey/fkey constraints do not.
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname AS old, 'coll_' || substring(c.relname from 5) AS new
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'data' AND c.relkind = 'r'
      AND c.relname ~ '^obj_[0-9a-f]{32}$'
  LOOP
    EXECUTE format('ALTER TABLE data.%I RENAME TO %I', r.old, r.new);
    EXECUTE format('ALTER TABLE data.%I RENAME CONSTRAINT %I TO %I',
                   r.new, r.old || '_pkey', r.new || '_pkey');
    EXECUTE format('ALTER TABLE data.%I RENAME CONSTRAINT %I TO %I',
                   r.new, r.old || '_id_fkey', r.new || '_id_fkey');
  END LOOP;
END $$;
--> statement-breakpoint

-- Persisted payloads. Every statement is guarded, so a re-run is a no-op.
--> statement-breakpoint
UPDATE "domain_events" SET "type" = 'collection' || substring("type" from 12)
  WHERE "type" LIKE 'object_type.%';
--> statement-breakpoint
UPDATE "domain_events" SET "payload" = replace(replace(replace(replace(
      "payload"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "payload" IS NOT NULL
    AND ("payload"::text LIKE '%"objectType%'
      OR "payload"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "pages" SET "definition" = replace(replace(replace(replace(
      "definition"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "definition" IS NOT NULL
    AND ("definition"::text LIKE '%"objectType%'
      OR "definition"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "pages" SET "published_definition" = replace(replace(replace(replace(
      "published_definition"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "published_definition" IS NOT NULL
    AND ("published_definition"::text LIKE '%"objectType%'
      OR "published_definition"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "page_versions" SET "definition" = replace(replace(replace(replace(
      "definition"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "definition" IS NOT NULL
    AND ("definition"::text LIKE '%"objectType%'
      OR "definition"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "ai_vectors" SET "metadata" = replace(replace(replace(replace(
      "metadata"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "metadata" IS NOT NULL
    AND ("metadata"::text LIKE '%"objectType%'
      OR "metadata"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "bulk_operations" SET "params" = replace(replace(replace(replace(
      "params"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "params" IS NOT NULL
    AND ("params"::text LIKE '%"objectType%'
      OR "params"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "tool_approval_requests" SET "payload" = replace(replace(replace(replace(
      "payload"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "payload" IS NOT NULL
    AND ("payload"::text LIKE '%"objectType%'
      OR "payload"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "tool_approval_requests" SET "operations" = replace(replace(replace(replace(
      "operations"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "operations" IS NOT NULL
    AND ("operations"::text LIKE '%"objectType%'
      OR "operations"::text LIKE '%"object_type_%');
--> statement-breakpoint
UPDATE "tool_approval_requests" SET "summary" = replace(replace(replace(replace(
      "summary"::text,
      '"objectTypeId"', '"collectionId"'),
      '"objectTypeKey"', '"collectionKey"'),
      '"object_type_id"', '"collection_id"'),
      '"object_type_key"', '"collection_key"')::jsonb
  WHERE "summary" IS NOT NULL
    AND ("summary"::text LIKE '%"objectType%'
      OR "summary"::text LIKE '%"object_type_%');
--> statement-breakpoint
-- Page datasets name their source kind inline.
UPDATE "pages" SET "definition" = regexp_replace("definition"::text, '"kind": *"objects"', '"kind": "collections"', 'g')::jsonb
  WHERE "definition"::text LIKE '%"objects"%';
--> statement-breakpoint
UPDATE "pages" SET "published_definition" = regexp_replace("published_definition"::text, '"kind": *"objects"', '"kind": "collections"', 'g')::jsonb
  WHERE "published_definition" IS NOT NULL AND "published_definition"::text LIKE '%"objects"%';
--> statement-breakpoint
UPDATE "page_versions" SET "definition" = regexp_replace("definition"::text, '"kind": *"objects"', '"kind": "collections"', 'g')::jsonb
  WHERE "definition"::text LIKE '%"objects"%';
--> statement-breakpoint
-- Tool policies are keyed by tool NAME. An unmatched key reads as "catalog
-- default", so a team that had explicitly blocked a tool would silently regain it.
UPDATE "team_tool_policies" SET "policies" = replace(replace(replace(replace(
      "policies"::text,
      '"describeObjectType"', '"describeCollection"'),
      '"manageObjectType"', '"manageCollection"'),
      '"listObjects"', '"listRecords"'),
      '"getObject"', '"getRecord"')::jsonb
  WHERE "policies" ?| array['describeObjectType','manageObjectType','listObjects','getObject'];
