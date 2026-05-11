import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * Projects-style persistent context injected into the chatbot system
 * prompt on every turn. Two scopes stack when both exist:
 *
 *  - `user`  — the user's personal instructions + context files.
 *  - `team`  — shared team instructions + context files. Any team
 *    member can edit, and any user can personally mute individual
 *    team resources via the `ai_context_user_*_mutes` tables without
 *    affecting other members.
 *
 * Aligned with Anthropic Claude Projects (static files + instructions
 * preloaded in the system prompt; not to be confused with Anthropic's
 * `memory_20250818` tool, which is agent-writable and scoped to a V2).
 */
export const aiContextScopeEnum = pgEnum("ai_context_scope", ["user", "team"]);

/**
 * Lifecycle of a context file. `uploading` and `extracting` are
 * transient states observed by the settings UI while extraction runs
 * fire-and-forget in the upload handler; `ready` is the terminal
 * success state (the `content` column is then populated); `error`
 * carries the failure reason in `errorMessage`.
 */
export const aiContextFileStatusEnum = pgEnum("ai_context_file_status", [
  "uploading",
  "extracting",
  "ready",
  "error",
]);

/**
 * One row per (user, org) and one per (team, org). Lazily upserted
 * the first time a user or team saves instructions / uploads a file.
 * A CHECK constraint makes sure exactly one of `userId` / `teamId` is
 * populated and matches `scope`.
 */
export const aiContextProfiles = pgTable(
  "ai_context_profiles",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    scope: aiContextScopeEnum("scope").notNull(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),

    instructions: text("instructions").notNull().default(""),

    /**
     * Who last saved the instructions. Useful at team scope so members
     * can see who touched the shared context (no admin gate on team
     * edits per product decision — any team member can edit).
     */
    updatedById: uuid("updated_by_id").references(() => user.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("ai_context_profiles_team_idx").on(
      table.teamId,
      table.organizationId,
    ),
    index("ai_context_profiles_user_idx").on(
      table.userId,
      table.organizationId,
    ),
    // Partial unique: one profile per (team, org) and one per (user, org).
    unique("ai_context_profiles_team_org_unique").on(
      table.teamId,
      table.organizationId,
    ),
    unique("ai_context_profiles_user_org_unique").on(
      table.userId,
      table.organizationId,
    ),
    // Exactly one of (userId, teamId) is non-null and matches scope.
    check(
      "ai_context_profiles_scope_check",
      sql`(${table.scope} = 'user' AND ${table.userId} IS NOT NULL AND ${table.teamId} IS NULL) OR (${table.scope} = 'team' AND ${table.teamId} IS NOT NULL AND ${table.userId} IS NULL)`,
    ),
  ],
);

/**
 * Files attached to a context profile. Lightweight mirror of
 * `documents` — no thumbnails, no pre-extract LLM classification, no
 * vectorisation. The `content` column holds the extracted markdown
 * (Mistral OCR for PDF/DOCX/PPTX/images, markdown tables for
 * XLSX/XLS/CSV, raw bytes for text/markdown/JSON). The same markdown
 * is also written to S3 as a `.md` sidecar (when `hasMarkdown` is
 * true) so the conversation-turn hydrator can drop it under
 * `/tmp/fretik-ai/{convId}/context/` for the standard `read` tool.
 * The `content` column itself is kept for the settings-UI preview
 * endpoint and as the lazy-backfill source for pre-refonte rows
 * uploaded before the sidecar pipeline existed.
 */
export const aiContextFiles = pgTable(
  "ai_context_files",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    profileId: uuid("profile_id")
      .notNull()
      .references(() => aiContextProfiles.id, { onDelete: "cascade" }),

    /**
     * Denormalised organisation id — lets handlers filter by
     * organisation without an extra JOIN, mirroring `aiChatFiles`.
     */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    filename: varchar("filename", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    fileHash: text("file_hash").notNull(), // SHA-256 of the original bytes.
    s3Key: varchar("s3_key").notNull(),

    status: aiContextFileStatusEnum("status").notNull().default("uploading"),
    errorMessage: text("error_message"),

    /**
     * Extracted markdown injected into the chatbot system prompt.
     * Null until extraction completes. Aligned with Anthropic's own
     * approach of embedding textual representations of uploaded files
     * directly in the context.
     */
    content: text("content"),

    /**
     * Char count of the FULL extraction (before any per-file cap) for
     * the settings UI budget gauge.
     */
    charCount: integer("char_count"),

    /**
     * Pages for OCR'd files, number of sheets for spreadsheets. Null
     * for plain text.
     */
    pageCount: smallint("page_count"),

    /**
     * True when an OCR/markdown sidecar was written to S3 alongside
     * the original bytes (key: `ai-context/{profileId}/{fileId}.md`).
     * Mirrors `ai_chat_files.hasMarkdown`. Set to `true` for PDF /
     * DOCX / PPTX / spreadsheet, and for images that yielded ≥ 20
     * non-whitespace chars of OCR text. Read by the conversation-turn
     * hydrator to know whether to download the sidecar in addition to
     * the original.
     */
    hasMarkdown: boolean("has_markdown").notNull().default(false),

    /**
     * Team-wide toggle (team scope) or personal toggle (user scope).
     * At team scope any member can flip this and the file is then
     * applied to nobody. Per-user overrides for team files live in
     * `ai_context_user_file_mutes` — a user can mute a team file just
     * for themselves without affecting the team.
     */
    enabled: boolean("enabled").notNull().default(true),

    uploadedById: uuid("uploaded_by_id").references(() => user.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("ai_context_files_profile_filename_unique").on(
      table.profileId,
      table.filename,
    ),
    index("ai_context_files_profile_enabled_idx").on(
      table.profileId,
      table.enabled,
    ),
    index("ai_context_files_hash_idx").on(table.fileHash),
    index("ai_context_files_error_idx")
      .on(table.status)
      .where(sql`${table.status} = 'error'`),
  ],
);

/**
 * Per-user override: "I do not want this team file applied to my
 * conversations" — without impacting other team members. Presence of a
 * row = muted. Joined (LEFT JOIN NOT NULL) in `loadAccessibleContext`
 * to exclude muted files from the manifest and from the
 * `read("context/...")` ACL check.
 *
 * Only meaningful for team-scope files; user-scope files are already
 * controlled by the owner via `ai_context_files.enabled`.
 */
export const aiContextUserFileMutes = pgTable(
  "ai_context_user_file_mutes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => aiContextFiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "ai_context_user_file_mutes_pk",
      columns: [table.userId, table.fileId],
    }),
    index("ai_context_user_file_mutes_user_idx").on(table.userId),
  ],
);

/**
 * Per-user override for team instructions: "I do not want this team's
 * instructions applied to my conversations". Always references a team
 * profile in practice (muting your own instructions makes no sense —
 * just clear them).
 */
export const aiContextUserProfileMutes = pgTable(
  "ai_context_user_profile_mutes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => aiContextProfiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "ai_context_user_profile_mutes_pk",
      columns: [table.userId, table.profileId],
    }),
    index("ai_context_user_profile_mutes_user_idx").on(table.userId),
  ],
);

// ==================== //
// TYPE INFERENCE       //
// ==================== //

export type AiContextProfile = typeof aiContextProfiles.$inferSelect;
export type NewAiContextProfile = typeof aiContextProfiles.$inferInsert;
export type AiContextScope = AiContextProfile["scope"];

export type AiContextFile = typeof aiContextFiles.$inferSelect;
export type NewAiContextFile = typeof aiContextFiles.$inferInsert;
export type AiContextFileStatus = AiContextFile["status"];

export type AiContextUserFileMute = typeof aiContextUserFileMutes.$inferSelect;
export type AiContextUserProfileMute =
  typeof aiContextUserProfileMutes.$inferSelect;
