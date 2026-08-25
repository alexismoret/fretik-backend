import { z } from "zod";
import {
  aiEpisodeKindEnum,
  aiEpisodeStateEnum,
} from "../db/schema/ai-episodes";

/**
 * HTTP schemas for the `/ai-memory/episodes` read-only surface — the
 * settings-UI window onto distilled episodic memory (P7). Mirrors the
 * `ai-memory.ts` pattern. Write/demote is deliberately out of scope: the
 * dreaming + GC crons own an episode's lifecycle, the UI only observes.
 */

export const episodeKindSchema = z.enum(aiEpisodeKindEnum.enumValues);
export type EpisodeKindValue = z.infer<typeof episodeKindSchema>;

export const episodeStateSchema = z.enum(aiEpisodeStateEnum.enumValues);
export type EpisodeStateValue = z.infer<typeof episodeStateSchema>;

export const EPISODE_LIST_DEFAULT_LIMIT = 50;
export const EPISODE_LIST_MAX_LIMIT = 200;

export const episodeListQuerySchema = z.object({
  kind: episodeKindSchema.optional(),
  state: episodeStateSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(EPISODE_LIST_MAX_LIMIT)
    .optional()
    .default(EPISODE_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const episodeIdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

/** List row — the lean shape (no summary/hashes/metadata). */
export const episodeSummarySchema = z.object({
  id: z.uuid(),
  kind: episodeKindSchema,
  state: episodeStateSchema,
  title: z.string(),
  /** Set = private to its author; null = team-visible. */
  isPrivate: z.boolean(),
  conversationId: z.uuid().nullable(),
  occurredFrom: z.date().nullable(),
  occurredTo: z.date().nullable(),
  recallCount: z.number().int(),
  lastRecalledAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type EpisodeSummaryResponse = z.infer<typeof episodeSummarySchema>;

export const episodeListResponseSchema = z.object({
  episodes: z.array(episodeSummarySchema),
});

export type EpisodeListResponse = z.infer<typeof episodeListResponseSchema>;

const episodeRecordRefSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  /** Object-type key — the `/collections/{collectionKey}/{id}` route segment. */
  collectionKey: z.string(),
});

const episodeConversationRefSchema = z.object({
  id: z.uuid(),
  title: z.string(),
});

/**
 * Workflow-run provenance — present when the episode was distilled from a
 * workflow run (the run reuses the conversation pipeline, so `conversation`
 * is also set, but the UI should link to the run, not the chatbot). Both ids
 * are read from the episode's `metadata` JSONB and are needed to build the
 * `/workflows/{workflowId}?run={workflowRunId}` link.
 */
const episodeWorkflowRefSchema = z.object({
  workflowId: z.uuid(),
  workflowRunId: z.uuid(),
});

/** Detail — the summary plus the distilled body, anchored records, source. */
export const episodeDetailSchema = episodeSummarySchema.extend({
  summary: z.string(),
  records: z.array(episodeRecordRefSchema),
  conversation: episodeConversationRefSchema.nullable(),
  workflow: episodeWorkflowRefSchema.nullable(),
});

export type EpisodeDetailResponse = z.infer<typeof episodeDetailSchema>;

// ==================== //
// DELETE               //
// ==================== //

/** Single soft-delete (hide) response. */
export const episodeOkResponseSchema = z.object({
  ok: z.literal(true),
});

export const deleteAllEpisodesBodySchema = z.object({
  /**
   * `user` = the caller's own private episodes; `team` = every episode in the
   * team (admin only — enforced in the handler via `isOrgAdmin`).
   */
  scope: z.enum(["user", "team"]),
});

export type DeleteAllEpisodesInput = z.infer<
  typeof deleteAllEpisodesBodySchema
>;

export const deleteAllEpisodesResponseSchema = z.object({
  hidden: z.number().int(),
});
