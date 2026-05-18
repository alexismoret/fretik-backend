import { sql } from "drizzle-orm";
import {
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { documents } from "./documents";

/**
 * Source of a field value. Captured for audit + UI hints
 * (e.g. "AI-extracted with low confidence" vs "user-edited").
 */
export const documentFieldValueSourceEnum = pgEnum(
  "document_field_value_source",
  ["ai_extraction", "user_manual", "user_correction", "template_default"],
);

/**
 * Per-document custom field values.
 *
 * Storage decision: single `value: jsonb` column.
 *   - JSON primitives map directly (`"invoice"`, `42`, `true`).
 *   - Multi-select naturally serialise to JSON arrays.
 *   - Dates are stored as ISO strings (`"2026-01-15T00:00:00Z"`).
 *   - Equality filters (`fieldKey = 'document_type' AND value = '"invoice"'::jsonb`)
 *     work with a B-tree on `(fieldKey, value)` because JSONB has a total order.
 *   - Containment filters (multi_select) use the GIN index.
 *
 * The row is keyed by `fieldKey` (the string slug from `fieldDefinitions.key`)
 * rather than `fieldDefinitionId`, so deleting + recreating a definition with
 * the same key does NOT orphan its values. The service layer guarantees the
 * slug matches a current definition for the document's team.
 */
export const documentFieldValues = pgTable(
  "document_field_values",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    fieldKey: varchar("field_key", { length: 60 }).notNull(),

    // JSON-encoded value. NEVER null — absence is represented by the row not
    // existing. `unknown` here keeps the typing honest; the service layer
    // narrows via the field definition's `type`.
    value: jsonb("value").$type<unknown>().notNull(),

    source: documentFieldValueSourceEnum("source")
      .notNull()
      .default("ai_extraction"),

    // Optional AI confidence for `source = 'ai_extraction'`.
    confidence: decimal("confidence", { precision: 3, scale: 2 }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("document_field_values_doc_key_uniq").on(
      table.documentId,
      table.fieldKey,
    ),
    index("document_field_values_field_key_idx").on(
      table.fieldKey,
      table.value,
    ),
    index("document_field_values_value_gin_idx").using("gin", table.value),
  ],
);

export type DocumentFieldValue = typeof documentFieldValues.$inferSelect;
export type NewDocumentFieldValue = typeof documentFieldValues.$inferInsert;
export type DocumentFieldValueSource = DocumentFieldValue["source"];
