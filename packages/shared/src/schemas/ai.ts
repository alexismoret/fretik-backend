import { z } from "@hono/zod-openapi";
import type { UIMessage } from "ai";
import {
  aiAgentTypeEnum,
  aiConversationMemberRoleEnum,
  aiVectorSourceTypeEnum,
} from "../db/schema";

/**
 * Agent types supported in ai_conversations. Kept in sync with the
 * `ai_agent_type` pg enum in db/schema/ai.ts.
 */
// Derived from the pg enum so a new agent kind (workflow, …) propagates
// to every response schema without re-declaration. Conversation CREATION
// stays chatbot-only below — workflow conversations are created by the
// engine, never through the chat API.
export const aiAgentTypeSchema = z.enum(aiAgentTypeEnum.enumValues);
export type AiAgentType = z.infer<typeof aiAgentTypeSchema>;
export const chatbotAgentTypeSchema = z.enum(["chatbot"]);

/**
 * Role of an AI message. Same values as the `ai_message_role` pg enum.
 * Tool invocations are embedded inside `parts`, not a separate role.
 */
export const aiMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type AiMessageRole = z.infer<typeof aiMessageRoleSchema>;

/**
 * Source type for a row in `ai_vectors` — backs the `ai_vector_source_type`
 * pg enum. Import this (or the raw enum from db/schema) anywhere you need to
 * validate / narrow a source type coming in from an API boundary or a tool
 * input. Keeps @fretik/ai and @fretik/api in sync with the DB column type and
 * makes the set of supported sources impossible to drift.
 */
export const aiVectorSourceTypeSchema = z.enum(
  aiVectorSourceTypeEnum.enumValues,
);

// ==================== //
// ai_vectors metadata //
// ==================== //

/**
 * Shape of a mentioned-record reference embedded inside a document vector's
 * metadata. Mirrors `MentionVectorInfo` from db/schema/ai-vectors.ts.
 */
export const mentionVectorInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  role: z.string(),
});

/**
 * Zod counterpart of `DocumentVectorMetadata` (db/schema/ai-vectors.ts).
 * Used by the `/internal/vectorize` endpoint in @fretik/ai to validate
 * payloads before they reach the DB, and by any future caller (API handler,
 * worker node) that builds or consumes document vector metadata. No
 * universal fields (team_id, organization_id, user_id, source_type, source_id)
 * — those are plain columns on the table, never duplicated in JSONB.
 */
export const documentVectorMetadataSchema = z.object({
  file_name: z.string(),
  file_type: z.string(),
  page_count: z.number().nullable(),
  document_language: z.string().nullable(),
  document_summary: z.string().nullable(),
  entities: z.array(mentionVectorInfoSchema),
  /**
   * Team-configurable custom field values keyed by `fieldDefinitions.key`.
   * The caller (shared/services/documents/upload.ts) pre-filters this to
   * fields whose definition has `vectorizeInclude=true`.
   */
  custom_fields: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.string()),
        z.null(),
      ]),
    )
    .default({}),
  is_metadata_only: z.boolean().optional(),
});

/**
 * Zod counterpart of `MemoryVectorMetadata` (db/schema/ai-vectors.ts).
 * Used by the `/internal/vectorize` endpoint to validate `memories`
 * payloads before they reach the DB. `scope` + `path` are duplicated
 * from `ai_memories` so retrieval-time consumers can render citations
 * without joining back; `team_id`, `organization_id`, `user_id`,
 * `source_type`, `source_id` stay on dedicated columns.
 */
export const memoryVectorMetadataSchema = z.object({
  scope: z.enum(["user", "team"]),
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Zod counterpart of `SkillVectorMetadata` (db/schema/ai-vectors.ts).
 * Skills are GLOBAL rows (team_id / organization_id / user_id all NULL).
 * The lookup key is the (skill_name, skill_file) tuple — the boot hook
 * `vectorizeAllBundledSkills` re-uses an existing source_id when the
 * tuple already has rows in `ai_vectors`, otherwise mints a new one
 * via `Bun.randomUUIDv7()`. `content_hash` is the SHA-256 hex digest
 * of the source markdown — the boot hook short-circuits when it's
 * unchanged since the previous indexing.
 */
export const skillVectorMetadataSchema = z.object({
  skill_name: z.string().min(1),
  skill_file: z.string().min(1),
  skill_description: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  version_indexed_at: z.string(),
});

/**
 * Zod counterpart of `ContextVectorMetadata` (db/schema/ai-vectors.ts).
 * Used by the `/internal/vectorize` endpoint to validate `context`
 * payloads. `scope` + `filename` are duplicated from `aiContextFiles`
 * so retrieval-time consumers render citations without a join;
 * `team_id`, `organization_id`, `user_id`, `source_type`, `source_id`
 * stay on dedicated columns.
 */
export const contextVectorMetadataSchema = z.object({
  scope: z.enum(["user", "team"]),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  profile_id: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Zod counterpart of `EpisodeVectorMetadata` (db/schema/ai-vectors.ts).
 * Used by the `/internal/vectorize` endpoint to validate `episodes`
 * payloads. `kind` + `title` + the occurrence window are duplicated from
 * `ai_episodes` so recall can render citations and filter by time
 * without joining back; `team_id`, `organization_id`, `user_id`,
 * `source_type`, `source_id` stay on dedicated columns.
 */
export const episodeVectorMetadataSchema = z.object({
  kind: z.enum(["conversation", "record_activity", "consolidated"]),
  title: z.string().min(1),
  conversation_id: z.uuid().nullable(),
  anchor_record_id: z.uuid().nullable(),
  occurred_from: z.string().nullable(),
  occurred_to: z.string().nullable(),
});

/**
 * Zod counterpart of `RecordVectorMetadata` (db/schema/ai-vectors.ts).
 * One "card" per CONFIRMED object record — content is built by
 * `services/object-records/build-card.ts`, single chunk per record.
 * `object_type_key` + `label` ride along for citation rendering.
 */
export const recordVectorMetadataSchema = z.object({
  object_type_id: z.uuid(),
  object_type_key: z.string().min(1),
  label: z.string().min(1),
});

// ==================== //
// Conversation CRUD    //
// ==================== //

export const CreateConversationSchema = z.object({
  title: z.string().min(1).max(255).openapi({
    example: "Q2 budget review",
    description: "Conversation title shown in the sidebar",
  }),
  agentType: chatbotAgentTypeSchema.optional().default("chatbot").openapi({
    example: "chatbot",
    description: "Agent responsible for this conversation",
  }),
  modelProfileKey: z.string().max(64).optional().openapi({
    example: "minimax-m3",
    description:
      "Flagship model picked for this conversation (chantier C8). Stamped at creation, immutable. Omitted → team default → code default.",
  }),
});
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationSchema = z.object({
  title: z.string().min(1).max(255).openapi({
    example: "Q2 budget review",
    description: "Updated conversation title",
  }),
});
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

/** Role of a participant inside a collaborative conversation. */
export const conversationMemberRoleSchema = z.enum(
  aiConversationMemberRoleEnum.enumValues,
);
export type ConversationMemberRole = z.infer<
  typeof conversationMemberRoleSchema
>;

/** A participant of a conversation, as returned in the member roster. */
export const ConversationMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  role: conversationMemberRoleSchema,
});
export type ConversationMemberResponse = z.infer<
  typeof ConversationMemberSchema
>;

export const ConversationResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid(),
  userId: z.uuid().nullable(),
  agentType: aiAgentTypeSchema,
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  /** Flagship model pinned to this conversation (chantier C8). Null = default. */
  modelProfileKey: z.string().nullable(),
  members: z.array(ConversationMemberSchema),
  /** The current user's role in this conversation. */
  role: conversationMemberRoleSchema,
  /** The current user's personal end-of-turn email opt-in. */
  emailOnCompletion: z.boolean(),
  /** When the current user last read the conversation (catch-up anchor). */
  lastReadAt: z.date().nullable(),
  /** When the current user joined — catch-up fallback when never read. */
  joinedAt: z.date(),
  /** New activity since the current user last opened the conversation. */
  unread: z.boolean(),
  /** The current user was @mentioned and hasn't read since. */
  actionRequired: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

// ==================== //
// Membership           //
// ==================== //

export const AddConversationMembersSchema = z.object({
  userIds: z.array(z.uuid()).min(1).openapi({
    description: "Team member ids to add as participants",
  }),
});
export type AddConversationMembersInput = z.infer<
  typeof AddConversationMembersSchema
>;

export const SetMemberEmailPreferenceSchema = z.object({
  emailOnCompletion: z.boolean().openapi({
    description:
      "The current user's personal opt-in to be emailed at the end of every assistant turn. Affects only the caller.",
  }),
});
export type SetMemberEmailPreferenceInput = z.infer<
  typeof SetMemberEmailPreferenceSchema
>;

export const MembersResponseSchema = z.array(ConversationMemberSchema);

/** "Summarise what I missed" — catch-up for a member opening a busy thread. */
export const ConversationSummaryResponseSchema = z.object({
  summary: z.string(),
});
export type ConversationSummaryResponse = z.infer<
  typeof ConversationSummaryResponseSchema
>;

// ==================== //
// Messages             //
// ==================== //

/**
 * The canonical message type is owned by the Vercel AI SDK and evolves
 * with it, so we use `z.custom<UIMessage>` to preserve the real static
 * type without re-deriving the full discriminated union. Runtime
 * validation is intentionally minimal because the `@ai-sdk/vue` `Chat`
 * class on the client produces these and already enforces the shape.
 */
export const UiMessageSchema = z.custom<UIMessage>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    "role" in value &&
    "parts" in value,
);
export type UiMessagePayload = z.infer<typeof UiMessageSchema>;

export const MessagesResponseSchema = z.array(UiMessageSchema);

// ==================== //
// Stream request       //
// ==================== //

export const ChatStreamRequestSchema = z.object({
  conversationId: z.uuid().openapi({
    description: "UUID of an existing conversation the user participates in",
  }),
  messages: z.array(UiMessageSchema).openapi({
    description:
      "Full messages array maintained by the AI SDK `Chat` class on the client",
  }),
  /**
   * Team members @mentioned in the new user message. Each is pulled into the
   * conversation and notified. When the message mentions humans but NOT the
   * assistant, the agent stays silent (human-to-human aside).
   */
  mentionedUserIds: z.array(z.uuid()).optional().openapi({
    description: "Team member ids @mentioned in the new user message",
  }),
  /**
   * True when the message explicitly @mentions the assistant. Forces the
   * agent to respond even alongside human mentions.
   */
  mentionsAssistant: z.boolean().optional().openapi({
    description: "Whether the new user message @mentions the assistant",
  }),
  /**
   * Per-turn "deep thinking" toggle. true → high reasoning effort for
   * this turn; absent/false → the model's default depth. Not persisted —
   * the user flips it freely per message (Claude-style). The server maps
   * this boolean to a `ReasoningLevel` so only the eval-validated rung is
   * reachable; a future advanced picker can add a level field additively.
   */
  deepThinking: z.boolean().optional().openapi({
    description:
      "Request high reasoning effort for this turn (deep thinking). Absent/false uses the model's default depth.",
  }),
});
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;
