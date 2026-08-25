import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";

/**
 * What kind of background work a task row tracks. Deliberately a `text`
 * column with a TS union rather than a pg enum: a new kind (a long document
 * batch, a connector sync, a deferred transform) must be one line here, not a
 * DDL migration. The `(kind, ref)` unique index carries the idempotence a
 * enum would not have given anyway.
 */
export const CONVERSATION_TASK_KINDS = [
  "workflow_run",
  "bulk_operation",
] as const;
export type ConversationTaskKind = (typeof CONVERSATION_TASK_KINDS)[number];

export const CONVERSATION_TASK_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
] as const;
export type ConversationTaskTerminalStatus =
  (typeof CONVERSATION_TASK_TERMINAL_STATUSES)[number];
export type ConversationTaskStatus = "pending" | ConversationTaskTerminalStatus;

/**
 * Kind-specific display/routing payload — never load-bearing for the resume.
 *
 * Display fields are STRUCTURED, not a sentence: `title` is a server string and
 * the frontend translates every word it shows, so a kind whose label is generated
 * (rather than user-supplied like a workflow's name) must ship the parts and let
 * the UI compose them.
 */
export interface ConversationTaskMetadata {
  workflowId?: string;
  isTest?: boolean;
  /** `bulk_operation` — what is being loaded, for the row's label. */
  importCollectionKey?: string;
  importRows?: number;
  /**
   * How far along, in whatever unit the kind counts (rows, steps, files).
   *
   * Generic on purpose, and this is the whole reason it lives HERE rather than
   * behind a per-kind endpoint: the task list is already polled while anything
   * is pending, so a kind that keeps these two numbers up to date gets a live
   * progress bar for free — no second query, no second component. A kind that
   * has nothing to count leaves them unset and shows none.
   */
  progressDone?: number;
  progressTotal?: number;
}

/**
 * Background work a chat conversation is waiting on.
 *
 * The agent launches something that outlives its turn (today: a workflow run),
 * keeps working, and ends the turn. Each launch registers a row here; each
 * terminal outcome completes it. When the LAST pending row of a conversation
 * goes terminal, the conversation is resumed exactly once — the claim is the
 * `consumed_at` stamp, taken by a single guarded UPDATE so two tasks finishing
 * concurrently still produce one resume.
 *
 * Rows are historical: they are never deleted on completion (the conversation
 * cascade is the only reaper), so the pending-tasks UI can show what just
 * finished and the sweeper can tell "never completed" from "already resumed".
 */
export const conversationBackgroundTasks = pgTable(
  "conversation_background_tasks",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    kind: text("kind").$type<ConversationTaskKind>().notNull(),

    /** Id of the tracked work in its own domain — a workflow run id today. */
    ref: text("ref").notNull(),

    /** Human label for the pending-tasks UI (the workflow's name). */
    title: text("title").notNull(),

    status: text("status")
      .$type<ConversationTaskStatus>()
      .notNull()
      .default("pending"),

    metadata: jsonb("metadata").$type<ConversationTaskMetadata>(),

    /** Set when the task went terminal, whatever the outcome. */
    completedAt: timestamp("completed_at", { withTimezone: true }),

    /**
     * Set when a resume turn has taken this outcome into account. The
     * fan-in anchor: a row is claimable only while this is NULL, and the
     * claiming UPDATE requires zero remaining pending rows in the same
     * conversation.
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Idempotent registration: a relaunch of the same run never double-books.
    uniqueIndex("conversation_background_tasks_kind_ref_uniq").on(
      t.kind,
      t.ref,
    ),
    // Every read path is "what is this conversation waiting on / owed".
    index("conversation_background_tasks_conversation_idx").on(
      t.conversationId,
    ),
    // The sweeper scans pending rows globally; keep it off the full history.
    index("conversation_background_tasks_pending_idx")
      .on(t.createdAt)
      .where(sql`status = 'pending'`),
  ],
);

export type ConversationBackgroundTask =
  typeof conversationBackgroundTasks.$inferSelect;
export type NewConversationBackgroundTask =
  typeof conversationBackgroundTasks.$inferInsert;
