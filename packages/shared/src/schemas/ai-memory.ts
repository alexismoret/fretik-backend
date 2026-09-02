import { z } from "@hono/zod-openapi";
import { aiMemoryActorEnum, aiMemoryScopeEnum } from "../db/schema/ai-memory";

/**
 * HTTP schemas for the `/ai-memory/*` routes. Mirrors the pattern of
 * `ai-context.ts` — every payload shape is reusable by the frontend
 * via `@fretik/shared/schemas`.
 *
 * The agent-side tool defines its own narrow Zod schemas inline (see
 * `backend/packages/ai/src/tools/memory.ts`); the schemas here describe
 * the human-facing settings UI surface (list / read / create / update /
 * delete / per-file history / cross-team activity feed).
 */

// ==================== //
// ENUMS                //
// ==================== //

export const aiMemoryScopeSchema = z.enum(aiMemoryScopeEnum.enumValues);
export type AiMemoryScopeValue = z.infer<typeof aiMemoryScopeSchema>;

export const aiMemoryActorSchema = z.enum(aiMemoryActorEnum.enumValues);
export type AiMemoryActorValue = z.infer<typeof aiMemoryActorSchema>;

export const aiMemoryOperationSchema = z.enum([
  "create",
  "overwrite",
  "rename",
  "delete",
]);
export type AiMemoryOperationValue = z.infer<typeof aiMemoryOperationSchema>;

// ==================== //
// CONSTANTS            //
// ==================== //

/**
 * Maximum content size accepted by the API. Mirrors `MEMORY_MAX_BYTES`
 * in `services/ai-memory/paths.ts` so the front-end can show a coherent
 * cap without importing a service module.
 */
export const MEMORY_MAX_CONTENT_BYTES = 50 * 1024;
export const MEMORY_MAX_PATH_LENGTH = 200;
export const MEMORY_MAX_DELETE_REASON_LENGTH = 500;
export const MEMORY_FEEDBACK_MAX_LIMIT = 50;

// ==================== //
// PATH PARAMS          //
// ==================== //

export const memoryIdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

// ==================== //
// QUERY PARAMS         //
// ==================== //

export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 100;

export const memoryListQuerySchema = z.object({
  scope: aiMemoryScopeSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEMORY_LIST_MAX_LIMIT)
    .optional()
    .default(MEMORY_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ==================== //
// REQUEST BODIES       //
// ==================== //

export const createMemoryBodySchema = z.object({
  scope: aiMemoryScopeSchema,
  /**
   * Path inside the namespace, e.g. `preferences.md` or
   * `vendors/acme.md`. **Optional** — when omitted the API calls
   * `suggestMemoryPath()` (an LLM via OpenRouter) so the user does
   * not have to pick a filename / folder. The handler prefixes
   * `/memories/<scope>/` and forwards to `createMemory()`, which
   * runs the full path validation either way.
   */
  path: z.string().min(1).max(MEMORY_MAX_PATH_LENGTH).optional(),
  content: z.string().max(MEMORY_MAX_CONTENT_BYTES),
});

export type CreateMemoryInput = z.infer<typeof createMemoryBodySchema>;

export const updateMemoryBodySchema = z.object({
  content: z.string().max(MEMORY_MAX_CONTENT_BYTES),
});

export type UpdateMemoryInput = z.infer<typeof updateMemoryBodySchema>;

export const deleteMemoryQuerySchema = z.object({
  /**
   * Optional free-form reason persisted in `ai_memory_history.reason`.
   * Surfaced in the per-file Historique modal so users can audit why
   * a teammate deleted something.
   */
  reason: z.string().max(MEMORY_MAX_DELETE_REASON_LENGTH).optional(),
});

export const deleteAllMemoriesBodySchema = z.object({
  /**
   * `user` = the caller's own user-scope notes; `team` = every note in the
   * team (admin only — enforced in the handler via `isOrgAdmin`).
   */
  scope: aiMemoryScopeSchema,
});

export type DeleteAllMemoriesInput = z.infer<
  typeof deleteAllMemoriesBodySchema
>;

export const deleteAllMemoriesResponseSchema = z.object({
  deleted: z.number().int(),
});

export const feedbackQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEMORY_FEEDBACK_MAX_LIMIT)
    .optional()
    .default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ==================== //
// RESPONSE SHAPES      //
// ==================== //

const memoryAttributionSchema = z.object({
  userId: z.uuid().nullable(),
  name: z.string().nullable(),
  actor: aiMemoryActorSchema,
  conversationId: z.uuid().nullable(),
});

export type MemoryAttribution = z.infer<typeof memoryAttributionSchema>;

export const memorySummarySchema = z.object({
  id: z.uuid(),
  scope: aiMemoryScopeSchema,
  path: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
  createdBy: memoryAttributionSchema,
  lastModifiedBy: memoryAttributionSchema,
});

export type MemorySummaryResponse = z.infer<typeof memorySummarySchema>;

export const memoryListResponseSchema = z.object({
  memories: z.array(memorySummarySchema),
  total: z.number().int(),
});

export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const memoryContentResponseSchema = memorySummarySchema.extend({
  content: z.string(),
});

export type MemoryContentResponse = z.infer<typeof memoryContentResponseSchema>;

export const memoryIdResponseSchema = z.object({ id: z.uuid() });

export const memoryOkResponseSchema = z.object({
  ok: z.literal(true),
  id: z.uuid().optional(),
});

const memoryHistoryUserSchema = z.object({
  userId: z.uuid().nullable(),
  name: z.string().nullable(),
});

export const memoryHistoryEntrySchema = z.object({
  id: z.uuid(),
  operation: aiMemoryOperationSchema,
  previousContent: z.string().nullable(),
  newContent: z.string().nullable(),
  previousPath: z.string().nullable(),
  newPath: z.string().nullable(),
  byUser: memoryHistoryUserSchema,
  byActor: aiMemoryActorSchema,
  byConversationId: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.date(),
});

export type MemoryHistoryEntryResponse = z.infer<
  typeof memoryHistoryEntrySchema
>;

export const memoryHistoryResponseSchema = z.object({
  entries: z.array(memoryHistoryEntrySchema),
});

export type MemoryHistoryResponse = z.infer<typeof memoryHistoryResponseSchema>;

/**
 * Activity-feed entry. Mirrors `memoryHistoryEntrySchema` plus a few
 * fields denormalised for the cross-file panel:
 *  - `memoryId` may be null when the memory has been deleted (the
 *    history row survives via `ON DELETE SET NULL`).
 *  - `scope` / `path` are best-effort: when the memory is gone we
 *    fall back to the `previous_path` captured on the audit row.
 *  - `triggeringUserMessage` is filled ONLY when `byUser.userId ===
 *    currentSessionUserId`. Reading another teammate's prompt is a
 *    privacy leak — the service nullifies the field for everyone else.
 */
export const memoryFeedbackEntrySchema = memoryHistoryEntrySchema.extend({
  memoryId: z.uuid().nullable(),
  scope: aiMemoryScopeSchema,
  path: z.string(),
  triggeringUserMessage: z.string().nullable(),
});

export type MemoryFeedbackEntryResponse = z.infer<
  typeof memoryFeedbackEntrySchema
>;

export const memoryFeedbackResponseSchema = z.object({
  entries: z.array(memoryFeedbackEntrySchema),
  total: z.number().int(),
});

export type MemoryFeedbackResponse = z.infer<
  typeof memoryFeedbackResponseSchema
>;
