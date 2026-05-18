import { z } from "@hono/zod-openapi";
import type { UIMessage } from "ai";
import { aiVectorSourceTypeEnum } from "../db/schema";

/**
 * Agent types supported in ai_conversations. Kept in sync with the
 * `ai_agent_type` pg enum in db/schema/ai.ts.
 */
export const aiAgentTypeSchema = z.enum(["chatbot"]);
export type AiAgentType = z.infer<typeof aiAgentTypeSchema>;

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
 * Shape of an entity reference embedded inside a document vector's metadata.
 * Mirrors the TypeScript `EntityVectorInfo` type from db/schema/ai-vectors.ts.
 */
export const entityVectorInfoSchema = z.object({
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
export const labelVectorInfoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export const documentVectorMetadataSchema = z.object({
  file_name: z.string(),
  file_type: z.string(),
  page_count: z.number().nullable(),
  document_language: z.string().nullable(),
  document_summary: z.string().nullable(),
  entities: z.array(entityVectorInfoSchema),
  labels: z.array(labelVectorInfoSchema).default([]),
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

// ==================== //
// Conversation CRUD    //
// ==================== //

export const CreateConversationSchema = z.object({
  title: z.string().min(1).max(255).openapi({
    example: "Résumé du connaissement MCOP0101",
    description: "Conversation title shown in the sidebar",
  }),
  agentType: aiAgentTypeSchema.optional().default("chatbot").openapi({
    example: "chatbot",
    description: "Agent responsible for this conversation",
  }),
});
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationSchema = z
  .object({
    title: z.string().min(1).max(255).optional().openapi({
      example: "Nouveau titre",
      description: "Updated conversation title",
    }),
    emailOnCompletion: z.boolean().optional().openapi({
      example: true,
      description:
        "When true, the conversation owner is emailed at the end of every assistant turn with the generated reply (and any presented files as attachments).",
    }),
  })
  .refine((v) => v.title !== undefined || v.emailOnCompletion !== undefined, {
    message: "At least one field must be provided",
  });
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

export const ConversationResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid(),
  userId: z.uuid().nullable(),
  agentType: aiAgentTypeSchema,
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  emailOnCompletion: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

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
    description: "UUID of an existing conversation owned by the user's team",
  }),
  messages: z.array(UiMessageSchema).openapi({
    description:
      "Full messages array maintained by the AI SDK `Chat` class on the client",
  }),
});
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;
