import type { UIMessage } from "ai";
import { sql } from "drizzle-orm";
import {
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
    index("ai_conversations_team_idx").on(t.teamId),
    index("ai_conversations_user_idx").on(t.userId),
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

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ai_messages_conversation_idx").on(t.conversationId),
    index("ai_messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
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
  ],
);
