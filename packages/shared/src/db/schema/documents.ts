import { sql } from "drizzle-orm";
import {
  bigint,
  decimal,
  index,
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
 * Pre-extraction results are stored in documentProperties (1:1) for
 * universal AI outputs (summary, language, page count) and in
 * documentFieldValues for the team-configurable custom fields
 * (document type, dates, category, …).
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

    // S3 storage — keys are derived from `id` (+ `originalFilename` for
    // the binary's extension) via `buildDocumentOriginalKey` /
    // `buildDocumentThumbnailKey` / `buildDocumentSidecarKey` in
    // `lib/document-storage.ts`. No DB column carries them.

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
 * Document Properties - universal AI-extracted outputs (1:1 with documents).
 * Created when processing completes successfully. Team-configurable fields
 * (document type, category, dates, …) live in `document_field_values`
 * and are configured per team via `field_definitions`.
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

    // Pre-extraction markdown lives on S3 at the key returned by
    // `buildDocumentSidecarKey(documentId)` in `lib/document-storage.ts`.
    // Spreadsheets (xlsx/csv) have no sidecar — the vectoriser falls
    // back to a metadata-only embedding for those.
    pageCount: smallint("page_count").notNull(),

    documentLanguage: varchar("document_language", { length: 5 }),
    documentSummary: text("document_summary").notNull(),

    confidenceScore: decimal("confidence_score", { precision: 3, scale: 2 }),

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

export type NewDocument = typeof documents.$inferInsert;
export type DocumentProperties = typeof documentProperties.$inferSelect;
export type NewDocumentProperties = typeof documentProperties.$inferInsert;
