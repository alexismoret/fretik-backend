import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";
import { collections } from "./collections";
import { type FieldDefinitionConfig, FIELD_TYPES } from "./field-types";

// The field-type catalogue + per-type config shapes live in `./field-types`
// (the single source of truth that also backs the runtime Zod registry and the
// frontend renderer registry), re-exported from the schema barrel. The pg enum
// is built from `FIELD_TYPES` so the DB and TS can never drift.

/**
 * Field value type. Drives the runtime Zod builder used in pre-extract,
 * the dynamic input components on the frontend, and the filter UI.
 */
export const fieldDefinitionTypeEnum = pgEnum(
  "field_definition_type",
  FIELD_TYPES,
);

/**
 * Field definitions table.
 *
 * Scope semantics:
 *   - `teamId IS NULL` → organization-level definition. Used as the template
 *     copied into a team's own definitions at team creation. Never read at
 *     document runtime.
 *   - `teamId IS NOT NULL` → team-level definition. The runtime source of
 *     truth: pre-extract, vectorize, panel rendering, filters all read these.
 *
 * Inheritance is copy-on-create only (org creation → applies `default`
 * template, team creation → duplicates the org's definitions). Editing an
 * org-scoped definition afterwards never propagates to existing teams.
 */
export const fieldDefinitions = pgTable(
  "field_definitions",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    // NULL = organization scope (template), set = team scope (runtime)
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    // The collection this field belongs to (was the document-only
    // `resourceType` enum). A field now attaches to ANY collection.
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),

    // Stable slug. Immutable post-create when values exist (enforced in the
    // service layer). Maps 1:1 with a key inside `collection_records.data`.
    key: varchar("key", { length: 60 }).notNull(),
    label: text("label").notNull(),
    // User-facing description AND `.describe()` source for the pre-extract
    // Zod runtime — the same text drives the field tooltip in the UI and the
    // schema block embedded in the pre-extract LLM prompt. Kept single
    // because both audiences benefit from the same precise wording.
    description: text("description"),

    type: fieldDefinitionTypeEnum("type").notNull(),
    config: jsonb("config")
      .$type<FieldDefinitionConfig>()
      .notNull()
      .default({}),

    aiExtractionEnabled: boolean("ai_extraction_enabled")
      .notNull()
      .default(true),
    vectorizeInclude: boolean("vectorize_include").notNull().default(true),
    displayInPanel: boolean("display_in_panel").notNull().default(true),
    // Designates the display-label field for the collection. At most one per
    // type per scope (enforced by partial unique index + service). The record's
    // denormalized `label` is computed from this field.
    isTitle: boolean("is_title").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),

    /**
     * Auto-index bookkeeping — the two timestamps that close the create/drop
     * loop on this field's column index (see `services/collection-schema/indexes`).
     *
     * `indexUnusedSince` is stamped by the maintenance pass the first time
     * Postgres reports ZERO scans for the index, and cleared as soon as it
     * reports any. Long enough at zero and the index is dropped, which stamps
     * `indexDroppedAt` — the flag reconciliation reads to know NOT to rebuild
     * it. Without it every pass would recreate exactly what the last one
     * dropped.
     *
     * Resurrection costs nothing: a query that filters or sorts on this field
     * clears `indexDroppedAt`, and the next pass rebuilds. The read path already
     * holds the field definition, so the check is a property lookup — the only
     * write happens in the rare case where a dropped index is wanted again.
     *
     * Lives here rather than in Redis because it is bounded (never a new row),
     * survives a cache flush — losing it would silently rebuild every dropped
     * index — and is cascade-deleted with the field.
     */
    indexUnusedSince: timestamp("index_unused_since", {
      mode: "date",
      withTimezone: true,
    }),
    indexDroppedAt: timestamp("index_dropped_at", {
      mode: "date",
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Two partial unique indexes — Postgres treats NULLs as distinct in a
    // standard UNIQUE so we need explicit partials to enforce "one (key) per
    // collection" at org scope and "one (key) per (team, collection)" at
    // team scope.
    uniqueIndex("field_definitions_org_key_uniq")
      .on(table.collectionId, table.key)
      .where(sql`team_id IS NULL`),
    uniqueIndex("field_definitions_team_key_uniq")
      .on(table.teamId, table.collectionId, table.key)
      .where(sql`team_id IS NOT NULL`),
    // At most one title field per collection per scope.
    uniqueIndex("field_definitions_org_title_uniq")
      .on(table.collectionId)
      .where(sql`is_title AND team_id IS NULL`),
    uniqueIndex("field_definitions_team_title_uniq")
      .on(table.teamId, table.collectionId)
      .where(sql`is_title AND team_id IS NOT NULL`),
    // Runtime lookup hot path: a team's enabled fields for a collection.
    index("field_definitions_collection_idx").on(table.collectionId),
    index("field_definitions_team_collection_idx")
      .on(table.teamId, table.collectionId)
      .where(sql`team_id IS NOT NULL`),
  ],
);

export type FieldDefinition = typeof fieldDefinitions.$inferSelect;
export type NewFieldDefinition = typeof fieldDefinitions.$inferInsert;
// `FieldDefinitionType` is re-exported above from `./field-types` (the source
// of truth). It is structurally identical to `FieldDefinition["type"]`.
