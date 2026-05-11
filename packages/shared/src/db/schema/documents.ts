import { sql } from "drizzle-orm";
import {
  bigint,
  decimal,
  index,
  json,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { team, user } from "./auth-schema";
import { folders } from "./folders";

/**
 * Document processing status enum
 */
export const documentStatusEnum = pgEnum("document_status", [
  "converting",
  "uploading",
  "processing",
  "ready",
  "error",
]);

/**
 * Documents - Files uploaded for storage and pre-processing
 * Supports PDF, Word, Excel, CSV, PowerPoint, and text files.
 * Non-PDF files are converted to PDF for thumbnails and processing.
 * Pre-extraction results are stored in documentProperties (1:1).
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Team ownership
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Folder organization (optional)
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "cascade",
    }),

    // Processing status
    status: documentStatusEnum("status").notNull().default("uploading"),
    errorMessage: text("error_message"),

    // File metadata
    originalFilename: varchar("original_filename").notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    fileHash: text("file_hash").notNull(), // SHA-256

    // S3 storage
    s3Key: varchar("s3_key").notNull(),
    s3ThumbnailKey: varchar("s3_thumbnail_key").notNull(),

    // Upload info
    uploadedById: uuid("uploaded_by_id").references(() => user.id, {
      onDelete: "set null",
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
    index("documents_team_idx").on(table.teamId),
    index("documents_folder_idx").on(table.folderId),
    index("documents_created_at_idx").on(table.createdAt),
    index("documents_file_hash_idx").on(table.fileHash),
    index("documents_status_idx").on(table.status),
  ],
);

/**
 * Document processing status enum
 */
export const transportModeEnum = pgEnum("transport_mode", [
  "sea",
  "air",
  "road",
  "rail",
  "inland_waterway",
  "multimodal",
]);

/**
 * Document processing status enum
 */
export const documentTypeEnum = pgEnum("document_type", [
  "invoice",
  "credit_note",
  "receipt",
  "statement",
  "contract",
  "order",
  "quotation",
  "certificate",
  "permit",
  "declaration",
  "report",
  "letter",
  "form",
  "list",
  "instruction",
  "specification",
  "plan",
  "notice",
  "record",
  "unknown",
]);

/**
 * Document Transport Types - Pre-extraction results (1:1 with documents)
 * Created only when processing completes successfully.
 */
export const documentTransportTypes = pgTable("document_transport_types", {
  code: varchar("code", { length: 100 }).primaryKey(),

  icon: varchar("icon"),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Document Properties - Global properties and pre-extraction results (1:1 with documents)
 * Created only when processing completes successfully.
 * All required fields are NOT NULL — no partial state.
 */
export const documentProperties = pgTable(
  "document_properties",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Link to document (unique 1:1)
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    // Pre-extraction results — JSON [{page: number, content: string}]
    // Null for Excel/CSV files
    markdown: text("markdown"),
    pageCount: smallint("page_count").notNull(),

    documentType: documentTypeEnum("document_type")
      .default("unknown")
      .notNull(),
    documentTransportType: varchar("document_transport_type").references(
      () => documentTransportTypes.code,
      {
        onDelete: "set null",
      },
    ),
    documentLanguage: varchar("document_language", { length: 5 }),
    documentSummary: text("document_summary").notNull(),
    documentDate: timestamp("document_date", {
      mode: "date",
      withTimezone: true,
    }),
    documentNumber: varchar("document_number", { length: 150 }),
    transportMode: transportModeEnum("transport_mode"),

    confidenceScore: decimal("confidence_score", { precision: 3, scale: 2 }),

    preExtractionMetadata: json("pre_extraction_metadata"),

    // Timestamps
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("document_properties_document_id_unique").on(table.documentId),
  ],
);

// Type inference
export type Document = typeof documents.$inferSelect;
export type DocumentStatus = Document["status"];
export type DocumentType =
  (typeof documentProperties.$inferSelect)["documentType"];

export type NewDocument = typeof documents.$inferInsert;
export type DocumentProperties = typeof documentProperties.$inferSelect;
export type NewDocumentProperties = typeof documentProperties.$inferInsert;
