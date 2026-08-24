import { sql } from "drizzle-orm";
import {
  bigint,
  decimal,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
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
 * Where a document's bytes come from.
 *
 * `uploaded` — a file the user (or the agent, via `uploadToDrive`) brought in.
 * `authored` — markdown written INSIDE Fretik: the S3 object IS the source of
 * truth and is editable, versioned (`document_versions`) and re-savable.
 *
 * Deliberately NOT a new `status`: `status` models the ingestion pipeline and
 * an authored document travels the same states (it is `ready` immediately, and
 * goes back through `processing` on a user-triggered re-extraction). The two
 * axes are orthogonal — this one answers "may I edit it", `status` answers
 * "is it usable yet".
 */
export const documentSourceEnum = pgEnum("document_source", [
  "uploaded",
  "authored",
]);

/** Who produced a document version — a person in the UI, or the agent. */
export const documentVersionActorEnum = pgEnum("document_version_actor", [
  "agent",
  "human",
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

    // Uploaded bytes vs markdown authored in-app (see `documentSourceEnum`).
    source: documentSourceEnum("source").notNull().default("uploaded"),

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

/**
 * Version history — for EVERY document, whatever its type.
 *
 * The product rule is deliberately one sentence with no format in it: a
 * document has a history, and any change to its content is a new version you
 * can go back to. Authoring markdown in-app, the agent rewriting it, or someone
 * dropping newer bytes over an uploaded PDF all land here. Restricting history
 * to the one editable format (the Claude Artifacts / Notion doctrine) only
 * stays coherent when the product has a single first-class content type; a
 * Drive holding PDFs, spreadsheets, authored markdown and — later — media has
 * to follow the Drive/SharePoint doctrine instead, where the version stack is
 * universal and diffing is the format-dependent bonus.
 *
 * A version is a POINTER, never content: `storageKey` + mime/size/hash. Bytes
 * belong on S3 (a 10 MB PDF base64'd into a text column is 13 MB of TOAST per
 * version, carried by every dump and every replica). Restoring is therefore a
 * server-side `copyObject` and works identically for markdown and for video.
 *
 * STORAGE INVARIANT — the newest version's `storageKey` IS the document's live
 * original key (`buildDocumentOriginalKey`). Creating a document costs no extra
 * byte, so the ~95% of documents nobody ever edits pay nothing. Only a
 * replacement archives the outgoing bytes to an immutable
 * `documents/{id}/v{n}{ext}` and repoints that row — one copy per replacement.
 *
 * Not S3 bucket versioning: that is a bucket-wide switch, so it would version
 * thumbnails, OCR sidecars and `temporary: true` scratch objects too, turn every
 * DELETE into a delete-marker (permanently drifting `storageUsedGb`), and still
 * carry none of the actor columns below — the table would survive regardless.
 *
 * Retention: `DOCUMENT_VERSION_RETENTION` per document, trimmed after each
 * write (`services/document-versions/record.ts`).
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    /**
     * `set null` on document delete, like `ai_memory_history.memoryId`: the
     * rows outlive the parent so an activity view can still account for what
     * happened. The denormalised `teamId` carries the scope once it is gone.
     */
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),

    /** Denormalised so the history stays queryable — and RLS-scopable —
     * without joining `documents`, which may already be deleted. */
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    /** 1-based, monotonic per document. What the UI labels "v3". */
    versionNumber: integer("version_number").notNull(),

    /**
     * `'create' | 'edit' | 'replace' | 'restore'`. Text, not an enum, so a new
     * operation never costs a migration — same call as `ai_memory_history`.
     * `edit` is an in-app authored save; `replace` is newer bytes dropped over
     * any document (re-upload, or the agent promoting a regenerated file).
     */
    operation: text("operation").notNull(),

    /** S3 key holding THIS version's bytes. See the storage invariant above. */
    storageKey: text("storage_key").notNull(),

    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    /** SHA-256 — also the dedup guard: bytes identical to the current version
     * produce no new version (the accidental re-upload of the same file). */
    fileHash: text("file_hash").notNull(),

    byUserId: uuid("by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    byActor: documentVersionActorEnum("by_actor").notNull(),
    /** Conversation behind an agent write. Null for edits made in the UI. */
    byConversationId: uuid("by_conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_versions_document_idx").on(table.documentId),
    index("document_versions_team_created_idx").on(
      table.teamId,
      table.createdAt,
    ),
    // Two writers must not mint the same version number. NULL documentIds
    // (post-delete rows) don't conflict in Postgres, which is what we want.
    uniqueIndex("document_versions_document_number_unique").on(
      table.documentId,
      table.versionNumber,
    ),
  ],
);

// Type inference
export type Document = typeof documents.$inferSelect;
export type DocumentStatus = Document["status"];

export type NewDocument = typeof documents.$inferInsert;
export type DocumentSource = Document["source"];
export type DocumentProperties = typeof documentProperties.$inferSelect;
export type NewDocumentProperties = typeof documentProperties.$inferInsert;

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
export type DocumentVersionActor = DocumentVersion["byActor"];
