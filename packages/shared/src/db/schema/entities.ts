import { sql } from "drizzle-orm";
import {
  decimal,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { team } from "./auth-schema";
import { documents } from "./documents";

/**
 * Entity status enum
 */
export const entityStatusEnum = pgEnum("entity_status", [
  "confirmed",
  "suggested",
  "rejected",
]);

/**
 * Entity type enum
 */
export const entityTypeEnum = pgEnum("entity_type", [
  "carrier",
  "client",
  "other",
]);

/**
 * Entity role in document context
 */
export const entityRoleEnum = pgEnum("entity_role", [
  "issuer",
  "customer",
  "mentioned",
  "broker",
  "consignee",
  "shipper",
]);

/**
 * Entity source — how the link was created
 */
export const entitySourceEnum = pgEnum("entity_source", [
  "ai_extraction",
  "user_manual",
  "user_correction",
]);

/**
 * Enrichment status for future auto-enrichment
 */
export const enrichmentStatusEnum = pgEnum("enrichment_status", [
  "pending",
  "enriched",
  "failed",
  "skipped",
]);

/**
 * Entities — organizations referenced in documents.
 * Can be carriers (CMA CGM, Air France), clients, or other companies (customs, government).
 * Status distinguishes confirmed entities from AI-suggested ones.
 * Matching uses pg_trgm trigram similarity on normalizedName + aliases array.
 */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Team ownership
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Status: confirmed = validated entity, suggested = auto-created by AI, rejected = dismissed suggestion
    status: entityStatusEnum("status").notNull().default("confirmed"),

    // Classification
    type: entityTypeEnum("type").notNull(),

    // Display name (canonical)
    name: varchar("name", { length: 200 }).notNull(),

    // Lowercase, stripped of legal suffixes and punctuation — used for matching
    normalizedName: varchar("normalized_name", { length: 200 }).notNull(),

    // Array of known alternative normalized names for alias matching
    aliases: text("aliases")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),

    // Optional notes
    notes: text("notes"),

    // Avatar image (S3 key)
    imageS3Key: varchar("image_s3_key", { length: 500 }),

    // Future enrichment fields
    website: varchar("website", { length: 500 }),
    address: text("address"),
    country: varchar("country", { length: 2 }),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 200 }),
    enrichmentStatus:
      enrichmentStatusEnum("enrichment_status").default("pending"),
    enrichedAt: timestamp("enriched_at", {
      mode: "date",
      withTimezone: true,
    }),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("entities_team_normalized_name_uniq").on(
      table.teamId,
      table.normalizedName,
    ),
    index("entities_team_idx").on(table.teamId),
    index("entities_team_status_idx").on(table.teamId, table.status),
  ],
);

/**
 * Junction table for document-entity many-to-many relationship.
 * A document can be linked to multiple entities with different roles.
 * Follows the same pattern as documentLabels.
 */
export const documentEntities = pgTable(
  "document_entities",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    // Role of the entity in this document context
    role: entityRoleEnum("role").notNull(),

    // How this link was created
    source: entitySourceEnum("source").notNull().default("ai_extraction"),

    // Confidence score (0.00-1.00), only for AI-sourced links
    confidence: decimal("confidence", { precision: 3, scale: 2 }),

    // Raw text returned by AI (for audit), nullable for manual links
    rawExtractedName: varchar("raw_extracted_name", { length: 200 }),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("document_entities_doc_entity_role_uniq").on(
      table.documentId,
      table.entityId,
      table.role,
    ),
    index("document_entities_document_idx").on(table.documentId),
    index("document_entities_entity_idx").on(table.entityId),
  ],
);

// Type inference
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityStatus = Entity["status"];
export type EntityType = Entity["type"];
export type DocumentEntity = typeof documentEntities.$inferSelect;
export type NewDocumentEntity = typeof documentEntities.$inferInsert;
export type EntityRole = DocumentEntity["role"];
export type EntitySource = DocumentEntity["source"];
