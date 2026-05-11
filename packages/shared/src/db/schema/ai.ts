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
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * Agent type discriminator for AI conversations.
 * Add new values here when we introduce new agents (workflow-builder,
 * extraction assistant, document pre-processor, …).
 */
export const aiAgentTypeEnum = pgEnum("ai_agent_type", ["chatbot"]);

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
     * Per-conversation toggle: when true, the chatbot handler emails the
     * conversation's owner at the end of every assistant turn with the
     * generated reply (and any `presentFiles` outputs as attachments).
     * Persisted so the user only has to flip it once per conversation.
     */
    emailOnCompletion: boolean("email_on_completion").notNull().default(false),

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
