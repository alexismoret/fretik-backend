import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatFileSnapshot } from "../../lib/chat-file-snapshot";
import { aiConversations, aiMessages } from "./ai";
import { user } from "./auth-schema";
import { documents } from "./documents";

/**
 * Per-chat-file processing status. `pending` is the initial insert state;
 * `uploading` while the S3 session put is in flight; `ocr` while
 * Mistral OCR is running for PDF / DOCX / PPTX / images; `ready` once
 * the file (and its optional markdown sidecar) are reachable from the
 * conversation's `/tmp/fretik-ai/{convId}/` sandbox; `error` if any
 * step failed with `errorMessage` populated.
 */
export const aiChatFileStatusEnum = pgEnum("ai_chat_file_status", [
  "pending",
  "uploading",
  "ocr",
  "ready",
  "error",
]);

/**
 * Per-conversation user-uploaded chat file. Distinct from the
 * `documents` table (Drive) and from persisted-output files (tool
 * results, path-only). Metadata lives here; the bytes live in the
 * Phase 3.1 session folder `chatbot-sessions/{conversationId}/` on S3
 * plus the `/tmp/fretik-ai/{convId}/` hot cache.
 *
 * `documentId` is populated when the user toggles "Save to Drive" at
 * upload time — the parallel `documentService.upload` returns a
 * regular `documents.id` which we keep here for cross-navigation and
 * FK cascade semantics. `messageId` is NULL at upload time (draft
 * state) and populated when the parent user message is persisted; the
 * orphan cleanup job keys off NULL + `createdAt` older than 24h to
 * reap abandoned drafts.
 *
 * See `chatbot-overhaul-plan.md` Phase 11 and
 * `chatbot-overhaul-progress.json::keyDecisions.chatFilesMetadataTable`.
 */
export const aiChatFiles = pgTable(
  "ai_chat_files",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),

    messageId: uuid("message_id").references(() => aiMessages.id, {
      onDelete: "set null",
    }),

    uploadedById: uuid("uploaded_by_id").references(() => user.id, {
      onDelete: "set null",
    }),

    filename: varchar("filename", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    hasMarkdown: boolean("has_markdown").notNull().default(false),
    /**
     * Structured preview of the file (rows + columns + head for
     * tabular, pages + excerpt + tables + image count + headings for
     * documents, lines + head for text, free-form hint otherwise).
     * Computed once at upload time by `extractChatFileSnapshot`
     * (`@fretik/shared/lib/chat-file-snapshot`) and rendered into the
     * chatbot's `<attached_file>` block at every turn so the model can
     * route to the right tool (`read` / `python` / `vision`) without
     * paginated discovery.
     *
     * NULL on legacy rows uploaded before Pattern A shipped, and on
     * uploads that bypass the standard pipeline. The renderer falls
     * back to filename-only when null.
     */
    snapshot: jsonb("snapshot").$type<ChatFileSnapshot>(),
    status: aiChatFileStatusEnum("status").notNull().default("pending"),
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
    index("ai_chat_files_conversation_created_idx").on(
      table.conversationId,
      sql`${table.createdAt} DESC`,
    ),
    unique("ai_chat_files_conversation_filename_unique").on(
      table.conversationId,
      table.filename,
    ),
    // Orphan detection: rows whose parent user message has not been
    // persisted yet. The orphan cleanup job scans this partial index
    // daily for rows older than 24h.
    index("ai_chat_files_orphans_idx")
      .on(table.conversationId, table.messageId)
      .where(sql`${table.messageId} IS NULL`),
    // Narrow partial index for support triage on failed rows.
    index("ai_chat_files_error_idx")
      .on(table.status)
      .where(sql`${table.status} = 'error'`),
  ],
);

export type AiChatFile = typeof aiChatFiles.$inferSelect;
export type NewAiChatFile = typeof aiChatFiles.$inferInsert;
export type AiChatFileStatus = AiChatFile["status"];
