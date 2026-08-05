import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { internalMiddleware } from "../middlewares/internal";
import { consolidateEpisodes } from "../services/memory/consolidate-episodes";
import { distillConversation } from "../services/memory/distill-conversation";
import { distillRecordActivity } from "../services/memory/distill-record-activity";
import { extractMentions } from "../services/memory/extract-mentions";
import { extractRelations } from "../services/memory/extract-relations";
import { promoteEpisodes } from "../services/memory/promote-episodes";
import { unsupersedeConsolidation } from "../services/memory/unsupersede-episodes";
import type { HonoInternalAppType } from "../types/hono";

/**
 * Internal memory endpoints, called by the @fretik/jobs workers. The
 * caller authenticates via `X-Internal-Key` + the standard `X-Context-*`
 * headers (enforced by `internalMiddleware`). As with /internal/vectorize,
 * `teamId` / `organizationId` also ride in the body for parity — the
 * services read them from there.
 *
 * POST /internal/memory/extract-mentions — mention extraction for the
 * memory-resolve worker (the async event→graph resolver, P3). Stateless
 * and side-effect free: text in, `{ mentions }` out. The caller owns
 * matching, banding, and link persistence.
 *
 * POST /internal/memory/distill-conversation — conversation → episode
 * distillation for the memory-distill worker (P4). Owns the whole
 * side-effectful pipeline: transcript + candidate records → LLM →
 * `upsertEpisode` → in-process vectorize when the content changed.
 *
 * POST /internal/memory/distill-record-activity — record events → rolling
 * digest episode for the dreaming cron (P6). Same ownership model.
 *
 * POST /internal/memory/consolidate-episodes — MERGE/REVISE/NOOP judge over
 * an episode cluster for the dreaming cron (P6): supersession, vector
 * drops, and the survivor's vectorize all happen service-side.
 *
 * POST /internal/memory/promote-episodes — episode → semantic promotion for
 * the dreaming cron (P8.5): durable, generalizable facts recurring across a
 * record's episodes are ADD/UPDATE'd into `ai_memories` under `learned/`.
 *
 * POST /internal/memory/unsupersede-episodes — the reverse of
 * consolidate-episodes: restore a survivor's superseded members and swap the
 * recall index back. Operator recourse for a wrong MERGE.
 */

const ExtractMentionsRequestSchema = z.object({
  // No max: the service truncates defensively (MAX_TEXT_CHARS) — a
  // caller sending an oversized text gets a clipped pass, not a 400.
  text: z.string().min(1),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

const memoryRoutes = new OpenAPIHono<HonoInternalAppType>();
memoryRoutes.use("*", internalMiddleware);

memoryRoutes.post("/extract-mentions", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = ExtractMentionsRequestSchema.safeParse(raw);
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
    const mentions = await extractMentions({
      text: parsed.data.text,
      teamId: parsed.data.teamId,
    });
    return c.json({ mentions }, 200);
  } catch (err) {
    console.error(
      `[memory] extract-mentions failed for team ${parsed.data.teamId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "EXTRACT_MENTIONS_ERROR",
        message: err instanceof Error ? err.message : "Extraction failed",
      },
      500,
    );
  }
});

const DistillConversationRequestSchema = z.object({
  conversationId: z.uuid(),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

memoryRoutes.post("/distill-conversation", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = DistillConversationRequestSchema.safeParse(raw);
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
    const result = await distillConversation(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    console.error(
      `[memory] distill-conversation failed for ${parsed.data.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "DISTILL_ERROR",
        message: err instanceof Error ? err.message : "Distillation failed",
      },
      500,
    );
  }
});

const DistillRecordActivityRequestSchema = z.object({
  recordId: z.uuid(),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

memoryRoutes.post("/distill-record-activity", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = DistillRecordActivityRequestSchema.safeParse(raw);
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
    const result = await distillRecordActivity(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    console.error(
      `[memory] distill-record-activity failed for ${parsed.data.recordId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "DISTILL_ERROR",
        message: err instanceof Error ? err.message : "Distillation failed",
      },
      500,
    );
  }
});

const ConsolidateEpisodesRequestSchema = z.object({
  episodeIds: z.array(z.uuid()).min(2).max(8),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

memoryRoutes.post("/consolidate-episodes", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = ConsolidateEpisodesRequestSchema.safeParse(raw);
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
    const result = await consolidateEpisodes(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    console.error(
      `[memory] consolidate-episodes failed for team ${parsed.data.teamId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "CONSOLIDATE_ERROR",
        message: err instanceof Error ? err.message : "Consolidation failed",
      },
      500,
    );
  }
});

const UnsupersedeEpisodesRequestSchema = z.object({
  survivorEpisodeId: z.uuid(),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

// The reverse of /consolidate-episodes — operator recourse for a wrong MERGE
// (restore members + swap the recall index). Internal-only, like every
// mutation here.
memoryRoutes.post("/unsupersede-episodes", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = UnsupersedeEpisodesRequestSchema.safeParse(raw);
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
    const result = await unsupersedeConsolidation(parsed.data);
    if (!result) {
      return c.json(
        {
          code: "NOT_FOUND",
          message: "No superseded members point at that episode",
        },
        404,
      );
    }
    return c.json(result, 200);
  } catch (err) {
    console.error(
      `[memory] unsupersede-episodes failed for team ${parsed.data.teamId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "UNSUPERSEDE_ERROR",
        message: err instanceof Error ? err.message : "Unsupersede failed",
      },
      500,
    );
  }
});

const ExtractRelationsRequestSchema = z.object({
  text: z.string().min(1),
  recordIds: z.array(z.uuid()).min(2),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

memoryRoutes.post("/extract-relations", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = ExtractRelationsRequestSchema.safeParse(raw);
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
    const result = await extractRelations(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    console.error(
      `[memory] extract-relations failed for team ${parsed.data.teamId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "EXTRACT_RELATIONS_ERROR",
        message: err instanceof Error ? err.message : "Extraction failed",
      },
      500,
    );
  }
});

const PromoteEpisodesRequestSchema = z.object({
  episodeIds: z.array(z.uuid()).min(2).max(12),
  teamId: z.uuid(),
  organizationId: z.uuid(),
});

memoryRoutes.post("/promote-episodes", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = PromoteEpisodesRequestSchema.safeParse(raw);
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
    const result = await promoteEpisodes(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    console.error(
      `[memory] promote-episodes failed for team ${parsed.data.teamId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json(
      {
        code: "PROMOTE_ERROR",
        message: err instanceof Error ? err.message : "Promotion failed",
      },
      500,
    );
  }
});

export { memoryRoutes };
