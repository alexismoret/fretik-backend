import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * Lifecycle of a content-addressed file extraction. `extracting` is the
 * transient state held while the first reader runs OCR (the UNIQUE
 * `(organization_id, file_hash)` row doubles as a cross-replica lock —
 * concurrent first-readers lose the INSERT and poll until `ready`);
 * `ready` once the markdown sidecar is on S3; `error` carries the
 * failure reason in `errorMessage`.
 */
export const fileExtractionStatusEnum = pgEnum("file_extraction_status", [
  "extracting",
  "ready",
  "error",
]);

/**
 * Content-addressed extraction cache, shared across every surface that
 * turns an uploaded file into model-readable text (chatbot attachments,
 * Drive `documents`, `ai_context_files`). Keyed by `(organizationId,
 * fileHash)` so the SAME bytes are extracted exactly once per org and
 * reused everywhere — re-uploading a file, attaching it to a second
 * conversation, or later saving it to Drive all hit this cache instead
 * of re-running OCR.
 *
 * Why org-scoped and nothing finer (no team/user): the extraction is a
 * pure function of the bytes, and a cache hit requires already
 * possessing identical bytes — so there is no cross-team leak, and
 * org-scoping maximises dedup while keeping tenant isolation + per-org
 * GDPR deletion trivial.
 *
 * The extracted markdown lives on S3 at the content-addressed key
 * `file-extractions/{organizationId}/{fileHash}.md` (and, for
 * multi-page OCR routes, `…/{fileHash}.pages.json` so the Drive
 * pre-extract pipeline keeps its per-page down-selection). This row
 * tracks status + location + counts; the bytes are NEVER stored here.
 *
 * Historical / cost-safe: NEVER deleted when a source file/document is
 * deleted — one extraction may back several sources. A refcounted GC
 * job can reap orphans later.
 */
export const fileExtractions = pgTable(
  "file_extractions",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Hex SHA-256 of the original bytes — the dedup key. */
    fileHash: varchar("file_hash", { length: 64 }).notNull(),

    /** Original MIME type that drove the routing decision. */
    mimeType: varchar("mime_type", { length: 100 }).notNull(),

    /**
     * Which extraction branch produced this entry: `mistral-ocr`
     * (PDF/DOCX/PPTX), `image-ocr` (image with usable text), `spreadsheet`
     * (exceljs, context-only), `legacy-import` (copied from a pre-refonte
     * session-prefix sidecar without re-OCR).
     */
    route: varchar("route", { length: 32 }).notNull(),

    /**
     * S3 key of the extracted markdown sidecar
     * (`file-extractions/{org}/{hash}.md`). NULL when the route produced
     * no usable text (e.g. a generic photo — `image-skip`).
     */
    sidecarS3Key: text("sidecar_s3_key"),

    /** Page count for OCR routes; NULL otherwise. */
    pageCount: integer("page_count"),

    /** Char count of the full extracted markdown. */
    charCount: integer("char_count"),

    status: fileExtractionStatusEnum("status").notNull().default("extracting"),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Dedup primitive + concurrency guard: the first reader wins the
    // INSERT; concurrent readers lose `ON CONFLICT DO NOTHING` and poll.
    unique("file_extractions_org_hash_unique").on(
      table.organizationId,
      table.fileHash,
    ),
    index("file_extractions_error_idx")
      .on(table.status)
      .where(sql`${table.status} = 'error'`),
  ],
);

export type FileExtraction = typeof fileExtractions.$inferSelect;
export type NewFileExtraction = typeof fileExtractions.$inferInsert;
export type FileExtractionStatus = FileExtraction["status"];
