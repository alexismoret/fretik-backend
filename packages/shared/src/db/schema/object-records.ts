import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  decimal,
  halfvec,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";
import { documents } from "./documents";
import { objectTypes } from "./object-types";
import { ontologySourceEnum, ontologyStatusEnum } from "./ontology-enums";

// Postgres tsvector (Drizzle ships no native column). Maintained by the
// service layer (NOT a generated column — the expression would have to be
// IMMUTABLE and can't reference the dynamic field catalog).
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Object records — the typed nodes of the unified graph. A record is one
 * instance of an object type: a Client row, a Pricing line, a Document mirror,
 * an AI-extracted Company. The same table holds user-curated CRM data AND
 * AI-extracted entities; trust is separated by `status` + `source`, not a
 * second table.
 *
 * No record-level bi-temporal columns: a record's per-attribute history is
 * derived by folding `domain_events` (the durable journal). World-time that
 * matters to a query (a price's year, a contract date) is a normal `data`
 * field.
 */
export const objectRecords = pgTable(
  "object_records",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // Optional private owner; NULL = team-shared.
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),

    objectTypeId: uuid("object_type_id")
      .notNull()
      .references(() => objectTypes.id, { onDelete: "cascade" }),

    // Attribute payload, validated at write by the runtime Zod built from the
    // type's field definitions (`buildRecordShape`).
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),

    // Denormalized display label (from the type's is_title field, or a built-in
    // for system types: filename for document, name for company/person).
    label: text("label").notNull(),
    // Lowercased/stripped label for trigram dedup + resolution (reuses
    // normalizeEntityName). Service-maintained.
    normalizedLabel: varchar("normalized_label", { length: 300 })
      .notNull()
      .default(""),
    // Known alternative normalized names — alias-array matching (match Stage 2).
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // BM25 full-text over label + the type's text fields. Service-maintained.
    searchVector: tsvector("search_vector"),

    // Trust / lifecycle (mirrors the proven entities model).
    status: ontologyStatusEnum("status").notNull().default("confirmed"),
    source: ontologySourceEnum("source").notNull().default("user_manual"),
    confidence: decimal("confidence", { precision: 4, scale: 3 }),
    // Provenance: the domain_events entry that produced/last-touched this row.
    // Soft reference (no FK) — domain_events is append-only and never deleted,
    // and a hard FK would create a table-creation cycle with domain_events.
    sourceEventId: uuid("source_event_id"),
    // RESERVED — merge target when two confirmed records are the same entity.
    mergedIntoId: uuid("merged_into_id").references(
      (): AnyPgColumn => objectRecords.id,
      { onDelete: "set null" },
    ),

    // RESERVED, UNUSED in V1 (semantic search goes via ai_vectors; no HNSW yet).
    embedding: halfvec("embedding", { dimensions: 2560 }),

    // 1:1 anchor to the uploaded file for `document` records.
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
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
    index("object_records_team_type_idx").on(table.teamId, table.objectTypeId),
    index("object_records_team_type_status_idx").on(
      table.teamId,
      table.objectTypeId,
      table.status,
    ),
    index("object_records_data_gin_idx").using("gin", table.data),
    index("object_records_search_gin_idx").using("gin", table.searchVector),
    index("object_records_normalized_label_idx").on(
      table.objectTypeId,
      table.normalizedLabel,
    ),
    index("object_records_normalized_label_trgm_idx").using(
      "gin",
      sql`${table.normalizedLabel} gin_trgm_ops`,
    ),
    index("object_records_aliases_gin_idx").using("gin", table.aliases),
    // 1:1 document ↔ record.
    uniqueIndex("object_records_document_uniq")
      .on(table.documentId)
      .where(sql`document_id IS NOT NULL`),
  ],
);

export type ObjectRecord = typeof objectRecords.$inferSelect;
export type NewObjectRecord = typeof objectRecords.$inferInsert;
