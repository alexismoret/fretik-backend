import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";

/**
 * Agent-writable memory store, inspired by Anthropic's `memory_20250818`
 * (file-system metaphor with `/memories/<scope>/<path>`) but custom-built
 * for Fretik:
 *
 *  - the chatbot runs on MiniMax M2.7 via OpenRouter (not Claude), so
 *    we cannot use the native tool — the storage backend is ours and
 *    the tool is a regular function tool exposed via the AI SDK;
 *  - every write carries an audit trail (who/agent vs human, which
 *    triggering assistant message) so the team panel can reason about
 *    "what did the agent learn and from whom";
 *  - two namespaces stack: `user` (private to a `userId`) and `team`
 *    (shared across the whole `teamId`).
 *
 * Distinct from `ai_context_*` (Projects-style static instructions +
 * uploaded files preloaded in the system prompt — human-edited only).
 * `ai_memories` is the dynamic, agent-curated knowledge base.
 */
export const aiMemoryScopeEnum = pgEnum("ai_memory_scope", ["user", "team"]);

/**
 * Discriminates writes by source. `agent` = written via the chatbot
 * `memory` tool during a conversation; `human` = written through the
 * settings UI (POST/PUT /ai-memory). The panel surfaces this so users
 * can audit what the agent has decided to memorize on its own.
 */
export const aiMemoryActorEnum = pgEnum("ai_memory_actor", ["agent", "human"]);

/**
 * One row per memory file. The conceptual path on the model side is
 * `/memories/<scope>/<path>` — we strip the `/memories/<scope>/` prefix
 * server-side and store only the relative `path`, with the namespace
 * encoded by `scope` + `userId`.
 *
 * Two unique partial indexes enforce path uniqueness within a scope:
 * `(teamId, userId, path)` for `scope='user'` and `(teamId, path)` for
 * `scope='team'`. The CHECK constraint guarantees `userId IS NOT NULL`
 * iff `scope='user'`, so every row is reachable through exactly one of
 * those indexes — including via the `ON CONFLICT` clause used by the
 * `overwrite` service for atomic upsert.
 */
export const aiMemories = pgTable(
  "ai_memories",
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

    scope: aiMemoryScopeEnum("scope").notNull(),

    /**
     * NOT NULL when scope='user' (CHECK enforced below). NULL when
     * scope='team' — any team member can read/write team memories.
     * `cascade` on user delete: a deleted user's private memories
     * disappear with them; team memories are preserved (their
     * `userId` is already NULL).
     */
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),

    /**
     * Relative path inside the namespace, e.g. `preferences.md` or
     * `carriers/dhl.md`. Validated server-side: 3–200 chars, Unicode
     * letters allowed (French entity names), no `..` / `\\` / `\0` /
     * URL-encoded traversal sequences.
     */
    path: text("path").notNull(),

    /**
     * Plain text / markdown payload. Capped at ~50 KB by the service
     * layer (using `Buffer.byteLength(content, 'utf8')`, since
     * `content.length` would count UTF-16 code units, not bytes).
     */
    content: text("content").notNull(),

    /**
     * Cached size in bytes. Mirrors `Buffer.byteLength(content, 'utf8')`
     * at write time so we can render the memory index manifest
     * (in the system prompt) without selecting `content`.
     */
    sizeBytes: integer("size_bytes").notNull(),

    // ---------------------------------------------------------------
    // Audit trail — who created and last modified this memory, and
    // which assistant message triggered the agent write (when
    // `*Actor='agent'`). All FKs are nullable + set-null so the audit
    // row survives user/message deletion (we keep the data, the
    // attribution becomes "by deleted user" downstream).
    // ---------------------------------------------------------------

    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByActor: aiMemoryActorEnum("created_by_actor").notNull(),
    /**
     * For agent-driven creates, points to the `ai_conversations` row
     * the chatbot was streaming when it issued the tool call. Lets the
     * activity panel (settings → Memory activity) link a write back to
     * the conversation that triggered it. Null for human writes
     * coming from the settings UI (no conversation context).
     *
     * Read from `AgentRuntimeContext.conversationId` inside the
     * `memory` tool — no extra plumbing on the streaming hot path,
     * no pre-stream stub row, no risk of orphan empty messages.
     */
    createdByConversationId: uuid("created_by_conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    lastModifiedByUserId: uuid("last_modified_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),
    lastModifiedByActor: aiMemoryActorEnum("last_modified_by_actor").notNull(),
    lastModifiedByConversationId: uuid(
      "last_modified_by_conversation_id",
    ).references(() => aiConversations.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    /**
     * Path uniqueness within a `user` scope. Partial index on
     * `scope='user'` so it does not interfere with the team uniqueness
     * below. `userId` is in the key — guaranteed NOT NULL by the CHECK.
     */
    uniqueIndex("ai_memories_user_path_uq")
      .on(t.teamId, t.userId, t.path)
      .where(sql`${t.scope} = 'user'`),
    uniqueIndex("ai_memories_team_path_uq")
      .on(t.teamId, t.path)
      .where(sql`${t.scope} = 'team'`),
    index("ai_memories_team_idx").on(t.teamId),
    index("ai_memories_team_user_idx").on(t.teamId, t.userId),

    /**
     * Trigram GIN index for `grep` (ILIKE) over `content`. Requires
     * `CREATE EXTENSION IF NOT EXISTS pg_trgm;` to run before the
     * migration applies the index — it is included at the top of the
     * generated SQL file, edit by hand if `db:generate` does not
     * detect the dependency.
     *
     * Tradeoff: a GIN trigram index typically weighs 3-5× the indexed
     * content, and slows down INSERT/UPDATE proportionally. Negligible
     * for a few thousand memories; revisit (drop or partial-index it
     * by team) if we cross 100k rows or write latency dérive.
     */
    index("ai_memories_content_trgm_idx").using(
      "gin",
      sql`${t.content} gin_trgm_ops`,
    ),

    /**
     * Enforce the user/scope coupling at the DB level. The service
     * layer already validates this, but the constraint protects
     * against any future code path that bypasses the service.
     */
    check(
      "ai_memories_scope_user_chk",
      sql`(${t.scope} = 'user' AND ${t.userId} IS NOT NULL) OR (${t.scope} = 'team' AND ${t.userId} IS NULL)`,
    ),
  ],
);

/**
 * Append-only audit log of every write/delete/rename on `ai_memories`.
 * Powers:
 *
 *  - the per-file "Historique" modal in the settings UI (timeline of
 *    versions with diff before/after);
 *  - the team-wide "Memory activity" panel listing the latest agent
 *    writes (diff-only by default — the triggering user message is
 *    only revealed to the user that made it, never cross-user);
 *  - the deletion-reason trail (`reason` filled when a human user
 *    confirms the delete modal with a free-form explanation).
 *
 * Retention strategy: keep the latest N=20 versions per `memoryId`.
 * Implemented by the write helper as a post-INSERT trim — keeps the
 * table bounded without a TTL job, and naturally evicts the oldest
 * version on the 21st write.
 */
export const aiMemoryHistory = pgTable(
  "ai_memory_history",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    /**
     * `set null` on memory delete: when the parent memory is removed,
     * its history rows stay so the activity panel can still surface
     * "X deleted memory Y on date" — denormalised `teamId` /
     * `previousPath` carry the context. Cascade would have wiped the
     * delete-event row that the `delete` service writes inside the
     * same transaction as the parent DELETE.
     */
    memoryId: uuid("memory_id").references(() => aiMemories.id, {
      onDelete: "set null",
    }),

    /**
     * Denormalised teamId so the activity panel can query the audit
     * log without joining `ai_memories` (which may be gone post-delete).
     */
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    /**
     * `'create' | 'overwrite' | 'rename' | 'delete'`. Stored as text
     * (not an enum) so we can extend without a migration.
     */
    operation: text("operation").notNull(),

    previousContent: text("previous_content"), // null for create
    newContent: text("new_content"), // null for delete
    previousPath: text("previous_path"), // populated for rename
    newPath: text("new_path"), // populated for rename

    byUserId: uuid("by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    byActor: aiMemoryActorEnum("by_actor").notNull(),
    /**
     * Conversation that triggered this audit event for `byActor='agent'`.
     * Null for human writes (settings UI). Set-null on conversation
     * delete keeps the audit row queryable via `teamId` + `previousPath`.
     */
    byConversationId: uuid("by_conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    /**
     * Optional free-form reason captured when a human user deletes a
     * memory through the settings UI. Useful debugging signal for
     * "why did this memory go away" — surfaced in the activity panel
     * for the user who entered it.
     */
    reason: text("reason"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ai_memory_history_memory_idx").on(t.memoryId),
    index("ai_memory_history_team_idx").on(t.teamId),
    index("ai_memory_history_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

// --- Inferred types ---

export type AiMemory = typeof aiMemories.$inferSelect;
export type NewAiMemory = typeof aiMemories.$inferInsert;
export type AiMemoryHistoryRow = typeof aiMemoryHistory.$inferSelect;
export type NewAiMemoryHistoryRow = typeof aiMemoryHistory.$inferInsert;
export type AiMemoryScope = (typeof aiMemoryScopeEnum.enumValues)[number];
export type AiMemoryActor = (typeof aiMemoryActorEnum.enumValues)[number];
export type AiMemoryOperation = "create" | "overwrite" | "rename" | "delete";
