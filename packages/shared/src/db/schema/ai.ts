import type { UIMessage } from "ai";
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
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { projects } from "./access";
import { organization, team, user } from "./auth-schema";

/**
 * Agent type discriminator for AI conversations.
 * Add new values here when we introduce new agents (workflow-builder,
 * extraction assistant, document pre-processor, …).
 */
export const aiAgentTypeEnum = pgEnum("ai_agent_type", ["chatbot", "workflow"]);

/**
 * Role of an AI message. Tool parts live inside `parts`, not as a separate role,
 * so we only need the three canonical roles defined by the Vercel AI SDK.
 */
export const aiMessageRoleEnum = pgEnum("ai_message_role", [
  "user",
  "assistant",
  "system",
]);

/**
 * Role of a participant inside a collaborative conversation. Flat model:
 * the creator is `owner` (sole actor allowed to delete the conversation),
 * everyone else is a `member`. A future chantier may add finer roles
 * (viewer/editor) — until then keep these two only.
 */
export const aiConversationMemberRoleEnum = pgEnum(
  "ai_conversation_member_role",
  ["owner", "member"],
);

/**
 * Conversation metadata. One row per user-visible conversation — owned by a
 * team (and organization), optionally linked to the user that started it.
 * `agentType` lets us host multiple agents side by side in the same table.
 */
export const aiConversations = pgTable(
  "ai_conversations",
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
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),

    // Access (see `db/schema/access.ts`). A conversation is private to its
    // participants (`ai_conversation_members`) unless it is opened to its
    // container: `accessRestricted = false` lets the team — or the project,
    // when `projectId` is set — read it and join. Private by default,
    // projects included: nobody's chat is published by being in a project.
    projectId: uuid("project_id").references(() => projects.id),
    accessRestricted: boolean("access_restricted").notNull().default(true),

    agentType: aiAgentTypeEnum("agent_type").notNull().default("chatbot"),

    title: text("title").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    /**
     * Model registry profile key pinning this conversation's flagship model
     * (chantier C8). Stamped at creation from the picker choice → team
     * default → code default, then **immutable** (no update path touches it)
     * so a later change of team default never re-targets an open
     * conversation. Null until the first turn resolves and stamps it; an
     * unknown/gate-failed key degrades to the current default at resolution.
     */
    modelProfileKey: varchar("model_profile_key", { length: 64 }),

    /**
     * UUID v7 of the currently-active resumable stream for this conversation.
     * Set when a new turn starts (POST /chatbot/stream), nullified by the
     * `onFinish` callback once the assistant messages are persisted.
     * Used by GET /chatbot/:id/stream to reattach the SSE on reconnect.
     * Null outside of an active turn.
     */
    activeStreamId: uuid("active_stream_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("ai_conversations_user_idx").on(t.userId),
    /**
     * The conversation list's ordering key. Equality on the first two columns
     * leaves `updated_at, id` as the sort, and the keyset walk seeks on that
     * same pair — so this index answers both the seek and the ORDER BY with no
     * Sort node. Declared ascending on purpose: the walk reads it backwards,
     * which Postgres does natively for a uniformly-reversed sort, and an
     * ascending index also serves any oldest-first reader.
     *
     * It also REPLACES the plain `(team_id)` index that stood here: `team_id`
     * leads this one, and a b-tree prefix answers every predicate the narrower
     * index could, including the `ON DELETE CASCADE` lookup behind the team
     * foreign key. Nothing in the codebase filters conversations by team alone
     * — the list paths pair it with `agent_type` (where this index resolves
     * both in the scan rather than filtering one afterwards) and every other
     * read reaches a conversation by primary key or through the members table.
     */
    index("ai_conversations_team_agent_updated_idx").on(
      t.teamId,
      t.agentType,
      t.updatedAt,
      t.id,
    ),
    index("ai_conversations_project_idx")
      .on(t.projectId)
      .where(sql`project_id IS NOT NULL`),
  ],
);

/**
 * Individual message rows. `parts` is stored as JSONB in the exact
 * `UIMessage.parts` shape used by `@ai-sdk/vue` — when the frontend loads a
 * conversation it drops this array straight into `chat.messages` with no
 * conversion. Covers text, reasoning, tool invocations, files, etc.
 */
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    /**
     * Human author of a `user` message. Null for `assistant`/`system` rows
     * (the agent has no user identity). Set to null on user deletion so the
     * transcript survives. Used to attribute messages in a collaborative
     * conversation: per-message avatar on the frontend, and conditional
     * `[Name]:` speaker labels fed to the model when ≥2 participants.
     */
    authorId: uuid("author_id").references(() => user.id, {
      onDelete: "set null",
    }),

    role: aiMessageRoleEnum("role").notNull(),
    parts: jsonb("parts").$type<UIMessage["parts"]>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    /**
     * Monotonic insertion counter — the ONLY ordering key for transcript
     * reads. `created_at` ties within a turn (multi-row INSERT shares one
     * `transaction_timestamp()`), which made `ORDER BY created_at` shuffle
     * a turn's messages across reloads. Identity is `BY DEFAULT` (not
     * `ALWAYS`) so the migration backfill could renumber existing rows in
     * `(created_at, id)` order.
     */
    seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),

    /**
     * Stream id of the turn that produced this message (assistant rows
     * only; the claim uuid from `ai_conversations.active_stream_id`).
     * Lets a resuming client trim the in-flight turn's partial messages
     * before replaying the turn log, and flags interrupted turns.
     */
    turnId: uuid("turn_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ai_messages_conversation_idx").on(t.conversationId),
    index("ai_messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    index("ai_messages_conversation_seq_idx").on(t.conversationId, t.seq),
  ],
);

/**
 * How a checkpoint's summary was produced. The ladder is ordered by fidelity,
 * and a checkpoint records which rung it came from because that decides how
 * much a reader can trust it — a `truncated` one is head-and-tail bytes, not a
 * summary, and a repair job re-derives those first.
 */
export const aiCheckpointKindEnum = pgEnum("ai_checkpoint_kind", [
  "llm",
  "mechanical",
  "truncated",
]);

/**
 * A persisted resume point for a conversation: the summary of everything up to
 * `up_to_message_id`, so the next turn loads that one row instead of the
 * history behind it.
 *
 * **Why a table and not a message row.** Three readers need the COMPLETE
 * history and must not see a summary — `presented-files.ts`, `collect-
 * outputs.ts` and the transcript API; `ai_messages.metadata` is not indexed,
 * so finding the latest checkpoint would mean a jsonb scan of the very rows
 * the checkpoint exists to avoid reading; and `rewind.ts` already establishes
 * that a row present-but-hidden makes the user and the model see two different
 * conversations. A derived artefact in its own table touches none of the three.
 *
 * **`up_to_message_id` is the truth, `up_to_seq` is a convenience.** `seq` is
 * `BY DEFAULT` precisely so a migration could renumber existing rows — a
 * pointer into a numbering that has already been rewritten once is not a
 * pointer. The FK also buys three things: a checkpoint written by a turn the
 * user rewound away fails to insert instead of succeeding, `ON DELETE CASCADE`
 * makes rewind invalidation redundant-but-free, and a repair job can always
 * re-summarise from the raw rows below the frontier.
 *
 * **`participant_ids` freezes the cast.** The summary is built from text that
 * already carries `[Name]:` speaker prefixes, so a member leaving would leave
 * a summary quoting somebody the conversation no longer contains. Storing the
 * roster lets the reader discard the checkpoint when it changes.
 *
 * **`generation` bounds summary-of-summaries.** Each checkpoint is normally
 * built from a window that STARTS with the previous one, and the package's own
 * verdict on that shape is blunt: "a second model pass over model output is a
 * summary of summaries". Past a cap the writer re-summarises from the raw rows
 * under the frontier instead, which the FK guarantees are still there.
 */
export const aiConversationCheckpoints = pgTable(
  "ai_conversation_checkpoints",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    /**
     * Last message this checkpoint summarises, INCLUSIVE. Cascade-deleted with
     * the row it points at, which is what makes a rewind self-invalidating.
     */
    upToMessageId: uuid("up_to_message_id")
      .notNull()
      .references(() => aiMessages.id, { onDelete: "cascade" }),

    /**
     * `seq` of `up_to_message_id`, denormalised so the window query is one
     * indexed read instead of a join. `mode: "number"` to match
     * `ai_messages.seq`: the `bigint` mode returns a `BigInt`, and every
     * comparison against a plain number would throw.
     */
    upToSeq: bigint("up_to_seq", { mode: "number" }).notNull(),

    summary: text("summary").notNull(),

    /**
     * Cumulative `searchTools` activations at the cut. Replayed as a synthetic
     * tool result beside the summary — without it every resumed turn falls
     * back to the base tool set and re-runs `searchTools`.
     */
    activatedTools: jsonb("activated_tools")
      .$type<string[]>()
      .notNull()
      .default([]),

    /** Conversation members at the cut. A change invalidates the checkpoint. */
    participantIds: jsonb("participant_ids")
      .$type<string[]>()
      .notNull()
      .default([]),

    /** 1 = summarised from raw rows; N = built on a generation-(N-1) summary. */
    generation: bigint("generation", { mode: "number" }).notNull().default(1),

    kind: aiCheckpointKindEnum("kind").notNull(),

    tokensBefore: bigint("tokens_before", { mode: "number" }).notNull(),
    tokensAfter: bigint("tokens_after", { mode: "number" }).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * Answers the only read there is — "the latest checkpoint for this
     * conversation" — as a backwards index scan with no sort, AND makes
     * concurrent writers idempotent: two turns racing the same cut collide
     * here instead of both inserting.
     */
    uniqueIndex("ai_conversation_checkpoints_conv_seq_idx").on(
      t.conversationId,
      t.upToSeq,
    ),
  ],
);

/**
 * Membership of a collaborative conversation (M2M conversation ↔ user).
 * One row per participant. Beyond access control, each row also carries the
 * participant's **per-user** state for that conversation:
 *  - `emailOnCompletion`: this member's own opt-in for end-of-turn emails
 *    (replaces the former per-conversation flag — each member decides alone).
 *  - `lastReadAt`: drives unread indicators in the conversation list.
 *  - `mentionedAt`: set when this member is @mentioned; powers the
 *    "action required" badge until they read (cleared on read).
 *  - `pinnedAt`: this member's pin, which floats the conversation to the top
 *    of THEIR list. Per member like everything else here: a conversation is
 *    shared, so a pin on `ai_conversations` would reorder a colleague's
 *    sidebar. The timestamp is the ordering key (newest pin first) and
 *    re-pinning preserves it, so a pinned row never moves under the user.
 *  - `joinedAt`: anchor for the "summarise what I missed" catch-up.
 */
export const aiConversationMembers = pgTable(
  "ai_conversation_members",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    role: aiConversationMemberRoleEnum("role").notNull().default("member"),

    emailOnCompletion: boolean("email_on_completion").notNull().default(false),

    lastReadAt: timestamp("last_read_at"),
    mentionedAt: timestamp("mentioned_at"),

    pinnedAt: timestamp("pinned_at"),

    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("ai_conversation_members_conversation_user_idx").on(
      t.conversationId,
      t.userId,
    ),
    index("ai_conversation_members_user_idx").on(t.userId),
    index("ai_conversation_members_conversation_idx").on(t.conversationId),
    /**
     * The pinned list, read FROM this table rather than through the
     * conversation. It only pays off that way round: a membership filter on
     * `ai_conversations` compiles to `EXISTS (… WHERE conversation_id = …
     * AND user_id = …)`, which the unique index above already serves exactly.
     *
     * Partial because a pin list is a shortlist — indexing the millions of
     * unpinned membership rows to find the handful of pinned ones is the whole
     * cost and none of the benefit.
     */
    index("ai_conversation_members_user_pinned_idx")
      .on(t.userId, t.pinnedAt)
      .where(sql`${t.pinnedAt} is not null`),
  ],
);
