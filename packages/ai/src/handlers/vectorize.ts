import type { AiVectorSourceType } from "@fretik/shared/db/schema";
import {
  contextVectorMetadataSchema,
  documentVectorMetadataSchema,
  episodeVectorMetadataSchema,
  memoryVectorMetadataSchema,
  pageVectorMetadataSchema,
  recordVectorMetadataSchema,
  workflowVectorMetadataSchema,
} from "@fretik/shared/schemas/ai";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { internalMiddleware } from "../middlewares/internal";
import { vectorizeSource } from "../services/vectorize";
import { vectorizePage } from "../services/vectorize/pages";
import { vectorizeWorkflow } from "../services/vectorize/workflows";
import type { HonoInternalAppType } from "../types/hono";

/**
 * POST /internal/vectorize
 *
 * Server-to-server ingestion endpoint called by @fretik/shared after a
 * document becomes vectorisable.
 *
 * The caller authenticates via `X-Internal-Key` + the standard
 * `X-Context-*` headers (enforced by `internalMiddleware`). Although
 * `teamId` / `organizationId` are carried in the HTTP context for
 * parity with the chatbot internal routes, we take them from the
 * request body so a single caller can vectorise cross-tenant sources
 * in a batch without re-issuing the request.
 *
 * Idempotent: `vectorizeSource` DELETEs existing rows for
 * `(sourceType, sourceId)` before re-inserting.
 */

/*
 * Compile-time anchor for the source type literals used in the
 * discriminated union below. Typing each constant as
 * `AiVectorSourceType` forces a TypeScript error the moment the
 * shared `ai_vector_source_type` pg enum drops `"documents"` — so
 * the handler can never silently drift from the DB column. Adding a
 * new enum value is a DB-schema change that MUST come with a new
 * branch here.
 */
const DOCUMENTS_SOURCE: AiVectorSourceType = "documents";
const MEMORIES_SOURCE: AiVectorSourceType = "memories";
const CONTEXT_SOURCE: AiVectorSourceType = "context";
const EPISODES_SOURCE: AiVectorSourceType = "episodes";
const RECORDS_SOURCE: AiVectorSourceType = "records";
const WORKFLOWS_SOURCE: AiVectorSourceType = "workflows";
const PAGES_SOURCE: AiVectorSourceType = "pages";

/**
 * Discriminated union on sourceType: a `documents` source must ship a
 * `DocumentVectorMetadata` payload. Invalid shapes fail the Zod parse
 * with a clear error path — no runtime casts needed downstream.
 */
const VectorizeRequestSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal(DOCUMENTS_SOURCE),
    sourceId: z.uuid(),
    /**
     * Pre-joined markdown of the document's OCR'd pages, or `null` /
     * omitted for tabular sources (Excel, CSV) where the page content
     * is not suitable for RAG. When null, the vectoriser falls back to
     * building a metadata-only semantic text.
     */
    content: z.string().nullish(),
    metadata: documentVectorMetadataSchema,
    teamId: z.uuid(),
    organizationId: z.uuid(),
  }),
  z.object({
    sourceType: z.literal(MEMORIES_SOURCE),
    sourceId: z.uuid(),
    content: z.string().min(1),
    metadata: memoryVectorMetadataSchema,
    teamId: z.uuid(),
    organizationId: z.uuid(),
    /**
     * NULL for team-scope memories (any team member reads/writes),
     * UUID for user-scope memories (private to the user). Mirrors
     * `ai_memories.user_id` and `ai_memories.scope` and powers the
     * `(team_id, user_id) WHERE source_type='memories'` partial index.
     */
    userId: z.uuid().nullable(),
  }),
  z.object({
    sourceType: z.literal(CONTEXT_SOURCE),
    sourceId: z.uuid(),
    content: z.string().min(1),
    metadata: contextVectorMetadataSchema,
    /**
     * Nullable for context: user-scope context profiles have NO team
     * (the parent `aiContextProfiles` row carries `teamId=null` per
     * its own `ai_context_profiles_scope_check`). Team-scope context
     * profiles set both. The `ai_vectors_scope_consistency` CHECK
     * accepts both shapes for `source_type='context'`.
     */
    teamId: z.uuid().nullable(),
    organizationId: z.uuid(),
    /**
     * NULL for team-scope context (every team member reads it), UUID
     * for user-scope context (private to the owner). Mirrors
     * `aiContextProfiles.scope` + `userId` and reuses the same
     * `(team_id, user_id) WHERE source_type IN ('memories','context')`
     * partial index as memories.
     */
    userId: z.uuid().nullable(),
  }),
  z.object({
    sourceType: z.literal(EPISODES_SOURCE),
    sourceId: z.uuid(),
    /** `title + "\n\n" + summary` — built by the distiller (≤ ~4.2KB). */
    content: z.string().min(1),
    metadata: episodeVectorMetadataSchema,
    teamId: z.uuid(),
    organizationId: z.uuid(),
    /**
     * NULL for team-visible episodes (multi-member conversations,
     * record-activity digests, consolidations), UUID for private ones
     * (single-member conversation episodes). Mirrors
     * `ai_episodes.user_id`.
     */
    userId: z.uuid().nullable(),
  }),
  z.object({
    sourceType: z.literal(RECORDS_SOURCE),
    sourceId: z.uuid(),
    /** The record "card" built by `buildRecordCard` — one chunk. */
    content: z.string().min(1),
    metadata: recordVectorMetadataSchema,
    teamId: z.uuid(),
    organizationId: z.uuid(),
  }),
  z.object({
    sourceType: z.literal(WORKFLOWS_SOURCE),
    /** The workflow id — a workflow card is identified by the workflow. */
    sourceId: z.uuid(),
    /** The workflow "card" built by `buildWorkflowCard` — one chunk. */
    content: z.string().min(1),
    /** `content_hash` + `version_indexed_at` are computed here, not sent. */
    metadata: workflowVectorMetadataSchema.omit({
      content_hash: true,
      version_indexed_at: true,
    }),
    teamId: z.uuid(),
    organizationId: z.uuid(),
    /** Owner of a private workflow; NULL when team-shared. */
    userId: z.uuid().nullable(),
  }),
  z.object({
    sourceType: z.literal(PAGES_SOURCE),
    /** The page id — a page card is identified by the page. */
    sourceId: z.uuid(),
    /** The page "card" built by `buildPageCard` — one chunk. */
    content: z.string().min(1),
    /** `content_hash` + `version_indexed_at` are computed here, not sent. */
    metadata: pageVectorMetadataSchema.omit({
      content_hash: true,
      version_indexed_at: true,
    }),
    teamId: z.uuid(),
    organizationId: z.uuid(),
    /** Owner of a private page; NULL when team-shared. */
    userId: z.uuid().nullable(),
  }),
]);

const vectorizeRoutes = new OpenAPIHono<HonoInternalAppType>();
vectorizeRoutes.use("*", internalMiddleware);

vectorizeRoutes.post("/", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = VectorizeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }

  try {
    // Forward the whole validated payload. The Zod discriminated union
    // has already narrowed `metadata` against `sourceType`, so this
    // assignment is type-safe without any runtime cast.
    // Workflow and page cards go through their own entry points: they own the
    // `content_hash` short-circuit, so re-saving one without a meaningful
    // change costs no embedding.
    const data = parsed.data;
    const runVectorize = () => {
      if (data.sourceType === "workflows") {
        return vectorizeWorkflow({
          workflowId: data.sourceId,
          teamId: data.teamId,
          organizationId: data.organizationId,
          userId: data.userId,
          name: data.metadata.name,
          description: data.metadata.description,
          triggerType: data.metadata.trigger_type,
          status: data.metadata.status,
          taskCount: data.metadata.task_count,
          content: data.content,
        });
      }
      if (data.sourceType === "pages") {
        return vectorizePage({
          pageId: data.sourceId,
          teamId: data.teamId,
          organizationId: data.organizationId,
          userId: data.userId,
          name: data.metadata.name,
          job: data.metadata.job,
          published: data.metadata.published,
          content: data.content,
        });
      }
      return vectorizeSource(data);
    };
    const result = await runVectorize();
    return c.json(
      {
        success: true,
        stats: result,
      },
      200,
    );
  } catch (err) {
    console.error(
      `[vectorize] failed for ${parsed.data.sourceType}/${parsed.data.sourceId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "VECTORIZE_ERROR",
        message: err instanceof Error ? err.message : "Vectorisation failed",
      },
      500,
    );
  }
});

export { vectorizeRoutes };
