import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { forbidden, notFound, throwHttpError } from "@fretik/shared/lib/errors";
import {
  createMemoryBodySchema,
  deleteMemoryQuerySchema,
  feedbackQuerySchema,
  memoryContentResponseSchema,
  memoryFeedbackResponseSchema,
  memoryHistoryResponseSchema,
  memoryIdParamSchema,
  memoryIdResponseSchema,
  memoryListQuerySchema,
  memoryListResponseSchema,
  memoryOkResponseSchema,
  updateMemoryBodySchema,
} from "@fretik/shared/schemas/ai-memory";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
  responseSuccessSchemaBuilder,
} from "@fretik/shared/schemas/common/responses";
import {
  episodeDetailSchema,
  episodeIdParamSchema,
  episodeListQuerySchema,
  episodeListResponseSchema,
} from "@fretik/shared/schemas/episodes";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { deleteMemory } from "@fretik/shared/services/ai-memory/delete";
import {
  getMemoryActivityFeed,
  type MemoryFeedbackEntry,
} from "@fretik/shared/services/ai-memory/get-activity-feed";
import { requireMemoryContent } from "@fretik/shared/services/ai-memory/get-content";
import { getMemoryHistory } from "@fretik/shared/services/ai-memory/get-history";
import { listMemoriesForUi } from "@fretik/shared/services/ai-memory/list-for-ui";
import { overwriteMemory } from "@fretik/shared/services/ai-memory/overwrite";
import { formatMemoryPath } from "@fretik/shared/services/ai-memory/paths";
import { suggestMemoryPath } from "@fretik/shared/services/ai-memory/suggest-path";
import {
  getEpisode,
  listEpisodes,
} from "@fretik/shared/services/episodes/list";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

// ==================== //
// ROUTER SETUP         //
// ==================== //

const aiMemoryRoutes = new OpenAPIHono<HonoLoggedAppType>();
aiMemoryRoutes.use("*", authMiddleware);

// ==================== //
// HELPERS              //
// ==================== //

interface SessionContext {
  organizationId: string;
  teamId: string;
  userId: string;
}

/**
 * Extract `(organizationId, teamId, userId)` from the auth-middleware
 * context. The whole memory surface is team-bound — without an active
 * team there is nothing to read or write, so we 403 fast instead of
 * silently routing to a null scope.
 */
const requireSession = (
  c: Parameters<Parameters<typeof aiMemoryRoutes.openapi>[1]>[0],
): SessionContext => {
  const user = c.get("user");
  const organization = c.get("organization");
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, forbidden("No active team in session"));
  }
  return {
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
  };
};

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const listRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List the agent memories visible to the active session",
  description:
    "Returns memories visible to the caller, paginated. Filter by `?scope=user|team` to drive the settings tabs (omitted scope merges both). Sorted by `updatedAt DESC`. The `content` field is omitted to keep the payload lean — fetch it via `/ai-memory/{id}/content` for the editor modal.",
  tags: ["AiMemory"],
  request: { query: memoryListQuerySchema },
  responses: {
    ...responseSuccessSchemaBuilder(memoryListResponseSchema, "Memories"),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getContentRoute = createRoute({
  method: "get",
  path: "/{id}/content",
  summary: "Read the full content of a memory file",
  tags: ["AiMemory"],
  request: { params: memoryIdParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(memoryContentResponseSchema, "Content"),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDefinition = createRoute({
  method: "post",
  path: "/",
  summary: "Create a new memory file (manual write from the settings UI)",
  description:
    "Mirrors the agent's `create` command but tags the audit trail as `actor='human'`. Fails with 409 if the path already exists in the same scope; use `PUT /ai-memory/{id}` to update existing entries.",
  tags: ["AiMemory"],
  request: {
    body: {
      content: { "application/json": { schema: createMemoryBodySchema } },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(memoryIdResponseSchema, "Memory created"),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateContentRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Replace the content of an existing memory file",
  tags: ["AiMemory"],
  request: {
    params: memoryIdParamSchema,
    body: {
      content: { "application/json": { schema: updateMemoryBodySchema } },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(memoryOkResponseSchema, "Memory updated"),
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a memory file (with optional reason for the audit log)",
  tags: ["AiMemory"],
  request: {
    params: memoryIdParamSchema,
    query: deleteMemoryQuerySchema,
  },
  responses: {
    ...responseSuccessSchemaBuilder(memoryOkResponseSchema, "Memory deleted"),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getHistoryRoute = createRoute({
  method: "get",
  path: "/{id}/history",
  summary: "Per-file audit timeline (latest 20 versions retained)",
  tags: ["AiMemory"],
  request: { params: memoryIdParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(memoryHistoryResponseSchema, "History"),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const listEpisodesRoute = createRoute({
  method: "get",
  path: "/episodes",
  summary: "List distilled episodic memories visible to the session",
  description:
    "Read-only window onto `ai_episodes` (conversation / record-activity / consolidated). Team episodes plus the caller's own private ones, newest first. Filter by `?kind=` / `?state=` (default state omitted = all). `summary` is omitted here — fetch it via `/ai-memory/episodes/{id}`.",
  tags: ["AiMemory"],
  request: { query: episodeListQuerySchema },
  responses: {
    ...responseSuccessSchemaBuilder(episodeListResponseSchema, "Episodes"),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getEpisodeRoute = createRoute({
  method: "get",
  path: "/episodes/{id}",
  summary: "One episode with its distilled body + anchored records",
  tags: ["AiMemory"],
  request: { params: episodeIdParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(episodeDetailSchema, "Episode"),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getFeedbackRoute = createRoute({
  method: "get",
  path: "/feedback",
  summary: "Cross-memory team activity feed for agent writes",
  description:
    "Returns the latest agent-driven writes against team-scope memories. The `triggeringUserMessage` field is filled only when the audit row's `byUserId` matches the calling user — never another teammate's prompt content.",
  tags: ["AiMemory"],
  request: { query: feedbackQuerySchema },
  responses: {
    ...responseSuccessSchemaBuilder(
      memoryFeedbackResponseSchema,
      "Activity feed",
    ),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// HANDLERS             //
// ==================== //

aiMemoryRoutes.openapi(listEpisodesRoute, async (c) => {
  const ctx = requireSession(c);
  const { kind, state, limit, offset } = c.req.valid("query");
  const { episodes } = await listEpisodes({
    teamId: ctx.teamId,
    userId: ctx.userId,
    kind,
    state,
    limit,
    offset,
  });
  return c.json(
    {
      episodes: episodes.map((e) => ({
        id: e.id,
        kind: e.kind,
        state: e.state,
        title: e.title,
        isPrivate: e.userId !== null,
        conversationId: e.conversationId,
        occurredFrom: e.occurredFrom,
        occurredTo: e.occurredTo,
        recallCount: e.recallCount,
        lastRecalledAt: e.lastRecalledAt,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    },
    200,
  );
});

aiMemoryRoutes.openapi(getEpisodeRoute, async (c) => {
  const ctx = requireSession(c);
  const { id } = c.req.valid("param");
  const episode = await getEpisode({
    episodeId: id,
    teamId: ctx.teamId,
    userId: ctx.userId,
  });
  if (!episode) {
    return throwHttpError(404, notFound("Episode not found"));
  }
  return c.json(
    {
      id: episode.id,
      kind: episode.kind,
      state: episode.state,
      title: episode.title,
      isPrivate: episode.userId !== null,
      conversationId: episode.conversationId,
      occurredFrom: episode.occurredFrom,
      occurredTo: episode.occurredTo,
      recallCount: episode.recallCount,
      lastRecalledAt: episode.lastRecalledAt,
      createdAt: episode.createdAt,
      updatedAt: episode.updatedAt,
      summary: episode.summary,
      records: episode.episodeRecords.flatMap((r) =>
        r.record && r.record.objectType
          ? [
              {
                id: r.record.id,
                label: r.record.label,
                typeKey: r.record.objectType.key,
              },
            ]
          : [],
      ),
      conversation: episode.conversation
        ? { id: episode.conversation.id, title: episode.conversation.title }
        : null,
    },
    200,
  );
});

aiMemoryRoutes.openapi(getFeedbackRoute, async (c) => {
  const ctx = requireSession(c);
  const { limit, offset } = c.req.valid("query");
  const { entries, total } = await getMemoryActivityFeed({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    currentUserId: ctx.userId,
    limit,
    offset,
  });
  // Date columns flow through Drizzle as `Date` objects, which Zod
  // dates accept verbatim. The schema infers them back as `z.date()`
  // so `c.json` serialises to ISO strings on the wire.
  return c.json(
    { entries: entries satisfies MemoryFeedbackEntry[], total },
    200,
  );
});

aiMemoryRoutes.openapi(listRoute, async (c) => {
  const ctx = requireSession(c);
  const { scope, limit, offset } = c.req.valid("query");
  const { memories, total } = await listMemoriesForUi({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    currentUserId: ctx.userId,
    scope,
    limit,
    offset,
  });
  return c.json({ memories, total }, 200);
});

aiMemoryRoutes.openapi(getContentRoute, async (c) => {
  const ctx = requireSession(c);
  const { id } = c.req.valid("param");
  const memory = await requireMemoryContent({
    id,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    currentUserId: ctx.userId,
  });
  return c.json(memory, 200);
});

aiMemoryRoutes.openapi(createRouteDefinition, async (c) => {
  const ctx = requireSession(c);
  const body = c.req.valid("json");

  // Resolve the path: when the UI omits it, ask the LLM to suggest
  // one based on the content + the existing paths in the same scope.
  // The suggester runs with a 4s timeout and falls back to a slug
  // derived from the content's first heading on error.
  let relativePath = body.path;
  if (!relativePath) {
    const { memories } = await listMemoriesForUi({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      currentUserId: ctx.userId,
      scope: body.scope,
      // Up to 200 paths is plenty to anchor the suggester on the
      // team's folder conventions; the service slices to 30 anyway.
      limit: 200,
      offset: 0,
    });
    relativePath = await suggestMemoryPath({
      scope: body.scope,
      content: body.content,
      scopeKey: ctx,
      existingPaths: memories.map((m) => m.path),
    });
  }

  const created = await createMemory({
    rawPath: formatMemoryPath({ scope: body.scope, relativePath }),
    content: body.content,
    scopeKey: ctx,
    actor: { actor: "human", userId: ctx.userId },
  });
  return c.json({ id: created.id }, 200);
});

aiMemoryRoutes.openapi(updateContentRoute, async (c) => {
  const ctx = requireSession(c);
  const { id } = c.req.valid("param");
  const { content } = c.req.valid("json");
  const existing = await requireMemoryContent({
    id,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    currentUserId: ctx.userId,
  });
  const result = await overwriteMemory({
    rawPath: formatMemoryPath({
      scope: existing.scope,
      relativePath: existing.path,
    }),
    content,
    scopeKey: ctx,
    actor: { actor: "human", userId: ctx.userId },
  });
  return c.json({ ok: true as const, id: result.memory.id }, 200);
});

aiMemoryRoutes.openapi(deleteRoute, async (c) => {
  const ctx = requireSession(c);
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("query");
  const existing = await requireMemoryContent({
    id,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    currentUserId: ctx.userId,
  });
  await deleteMemory({
    rawPath: formatMemoryPath({
      scope: existing.scope,
      relativePath: existing.path,
    }),
    scopeKey: ctx,
    actor: { actor: "human", userId: ctx.userId },
    reason,
  });
  return c.json({ ok: true as const }, 200);
});

aiMemoryRoutes.openapi(getHistoryRoute, async (c) => {
  const ctx = requireSession(c);
  const { id } = c.req.valid("param");
  const entries = await getMemoryHistory({
    memoryId: id,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    currentUserId: ctx.userId,
  });
  if (entries === null) {
    return throwHttpError(404, notFound("Memory file not found"));
  }
  return c.json({ entries }, 200);
});

export { aiMemoryRoutes };
