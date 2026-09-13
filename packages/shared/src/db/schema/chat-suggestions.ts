import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * What a suggestion is FOR, in the order it earns a slot. The kind is not
 * decoration: it is how the generator is told to spend six slots on six
 * different things instead of six follow-ups, and it is the axis the
 * click-through rate is read along when the prompt is tuned.
 *   - pending    — something is waiting on this person (an approval, a run
 *                  that failed)
 *   - follow_up  — an open thread or a decision that has no conclusion yet
 *   - periodic   — a rhythm the dates make visible (a weekly report, a
 *                  month-end close)
 *   - insight    — a pattern across records or episodes worth a look
 *   - capability — a workflow or a page the team owns and is not using
 */
export const chatSuggestionKindEnum = pgEnum("chat_suggestion_kind", [
  "pending",
  "follow_up",
  "periodic",
  "insight",
  "capability",
]);

/**
 * Lifecycle of one suggestion. Nothing is deleted, because the resolved rows
 * are the feature's only quality signal: what people click and what they
 * dismiss is what says whether the prompt is any good, and the last two weeks
 * of them are fed back to the generator so a rejected idea does not return.
 *   - active     — currently offered
 *   - used       — the person sent it
 *   - dismissed  — the person rejected it
 *   - superseded — a newer batch replaced it before anyone acted
 */
export const chatSuggestionStatusEnum = pgEnum("chat_suggestion_status", [
  "active",
  "used",
  "dismissed",
  "superseded",
]);

/**
 * Personalized chat suggestions — the four inert cards on the chatbot home
 * screen, replaced by prompts written from this reader's own recent work.
 *
 * PER USER, not per team, and that is the load-bearing choice: the context
 * they are generated from includes the reader's PRIVATE episodes and private
 * memories (`user_id IS NULL OR user_id = :caller`), so a team-scoped artefact
 * could not carry them without leaking. It is also what makes them useful —
 * two colleagues on the same team have different open threads.
 *
 * One row per suggestion rather than a batch with an items array: `status` is
 * per item, the "do not repeat what was dismissed" query is a plain `WHERE`,
 * and the click-through rate per kind is a `GROUP BY`. A jsonb array would
 * make all three a scan.
 *
 * `batch_id` groups the rows one generation produced, so replacing a batch is
 * one `UPDATE … SET status='superseded'` plus one multi-row insert, and the
 * cache key (`input_hash`) is carried by every row of the batch it describes.
 */
export const chatSuggestions = pgTable(
  "chat_suggestions",
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
    /** The reader. A suggestion is never served to anyone else. */
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** Groups the rows one generation wrote. v7, so it also orders them. */
    batchId: uuid("batch_id").notNull(),

    kind: chatSuggestionKindEnum("kind").notNull(),

    /** The card's title — imperative, what the person gets. */
    label: varchar("label", { length: 80 }).notNull(),
    /** The message actually sent when the card is clicked. */
    prompt: text("prompt").notNull(),
    /** One line of "why now", shown under the label. */
    reason: varchar("reason", { length: 160 }).notNull(),

    /**
     * The context ids the suggestion rests on (`episode:<uuid>`,
     * `conversation:<uuid>`, …). Provenance, and the gate the parser applies:
     * a suggestion citing an id that was not in the context is dropped rather
     * than shown, because that is what an invented fact looks like here.
     */
    sourceRefs: jsonb("source_refs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    status: chatSuggestionStatusEnum("status").notNull().default("active"),

    /**
     * Fingerprint of the context the batch was generated from. A GET compares
     * it to the current context to decide whether anything has changed; it is
     * why an idle user costs no LLM call at all.
     */
    inputHash: text("input_hash").notNull(),
    /** Which model wrote it — a batch outlives the setting that chose it. */
    modelKey: varchar("model_key", { length: 64 }).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** When it left `active` — used, dismissed or superseded. */
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => [
    // The read every page load makes: this reader's active batch.
    index("chat_suggestions_user_team_status_idx").on(
      table.userId,
      table.teamId,
      table.status,
    ),
    // The anti-repetition read: what this reader resolved recently.
    index("chat_suggestions_user_resolved_idx").on(
      table.userId,
      table.resolvedAt,
    ),
  ],
);

export type ChatSuggestionRow = typeof chatSuggestions.$inferSelect;
export type NewChatSuggestionRow = typeof chatSuggestions.$inferInsert;
export type ChatSuggestionKind = ChatSuggestionRow["kind"];
export type ChatSuggestionStatus = ChatSuggestionRow["status"];
