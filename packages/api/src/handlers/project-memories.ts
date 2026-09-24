import {
  access,
  type ResourceEnv,
  teamOfResource,
} from "@fretik/shared/authz/http";
import { assertProjectNotArchived } from "@fretik/shared/authz/placement";
import type { HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { notFound, throwHttpError } from "@fretik/shared/lib/errors";
import {
  createProjectMemoryBodySchema,
  deleteAllMemoriesResponseSchema,
  deleteMemoryQuerySchema,
  memoryContentResponseSchema,
  memoryHistoryResponseSchema,
  memoryIdResponseSchema,
  memoryListResponseSchema,
  memoryOkResponseSchema,
  projectMemoryListQuerySchema,
  projectMemoryParamsSchema,
  updateMemoryBodySchema,
} from "@fretik/shared/schemas/ai-memory";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { deleteMemory } from "@fretik/shared/services/ai-memory/delete";
import { deleteAllMemories } from "@fretik/shared/services/ai-memory/delete-all";
import { requireProjectMemoryContent } from "@fretik/shared/services/ai-memory/get-content";
import { getProjectMemoryHistory } from "@fretik/shared/services/ai-memory/get-history";
import { listProjectMemoriesForUi } from "@fretik/shared/services/ai-memory/list-for-ui";
import { overwriteMemory } from "@fretik/shared/services/ai-memory/overwrite";
import { formatMemoryPath } from "@fretik/shared/services/ai-memory/paths";
import { suggestMemoryPath } from "@fretik/shared/services/ai-memory/suggest-path";
import type { MemoryScopeKey } from "@fretik/shared/services/ai-memory/types";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

/**
 * `/projects/{id}/memories` — a project's notes: what its people and the
 * assistant keep for it, read in every one of its chats (`/memories/project/`
 * on the assistant's side).
 *
 * Its levels decide, as for its instructions: `view` reads the notes, `edit`
 * writes them, `full` clears them all. A note is the project's, kept in the
 * project's team, whatever team the caller has open. An archived project
 * changes nothing until restored (409 `PROJECT_ARCHIVED`).
 *
 * Mounted by `projects.ts` inside `/projects`, behind its session
 * middleware: a second router on the same prefix in `src/index.ts` would run
 * that middleware twice on every request.
 */
const projectMemoryRoutes = new OpenAPIHono<HonoLoggedAppType>();

/**
 * Whose notes, as the memory services key them: the project's, in its team,
 * written by the caller.
 */
const projectScopeKey = (c: Context<ResourceEnv>): MemoryScopeKey => {
  const resource = c.get("resource");
  return {
    organizationId: c.get("principal").organizationId,
    teamId: teamOfResource(resource),
    userId: c.get("user").id,
    projectId: resource.node.id,
  };
};

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const listRoute = createRoute({
  method: "get",
  path: "/{id}/memories",
  middleware: access.resource("project", "view"),
  summary: "A project's notes",
  description:
    "Newest first, paginated. The `content` field is omitted; fetch it via `/projects/{id}/memories/{memoryId}/content`.",
  tags: ["Projects"],
  request: { params: paramsIdSchema, query: projectMemoryListQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: memoryListResponseSchema } },
      description: "The notes",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const getContentRoute = createRoute({
  method: "get",
  path: "/{id}/memories/{memoryId}/content",
  middleware: access.resource("project", "view"),
  summary: "One of a project's notes, with its content",
  tags: ["Projects"],
  request: { params: projectMemoryParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: memoryContentResponseSchema } },
      description: "The note",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const getHistoryRoute = createRoute({
  method: "get",
  path: "/{id}/memories/{memoryId}/history",
  middleware: access.resource("project", "view"),
  summary: "The versions of one of a project's notes",
  tags: ["Projects"],
  request: { params: projectMemoryParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: memoryHistoryResponseSchema } },
      description: "Its versions, most recent first",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const createNoteRoute = createRoute({
  method: "post",
  path: "/{id}/memories",
  middleware: access.resource("project", "edit"),
  summary: "Write a note for the project",
  description:
    "Tagged `actor='human'` in its history. Without a `path`, one is suggested from the content. 409 when the path is taken, or the project is archived.",
  tags: ["Projects"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: createProjectMemoryBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: memoryIdResponseSchema } },
      description: "The note written",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const updateNoteRoute = createRoute({
  method: "patch",
  path: "/{id}/memories/{memoryId}",
  middleware: access.resource("project", "edit"),
  summary: "Change one of a project's notes",
  tags: ["Projects"],
  request: {
    params: projectMemoryParamsSchema,
    body: {
      content: { "application/json": { schema: updateMemoryBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: memoryOkResponseSchema } },
      description: "The note, changed",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteNoteRoute = createRoute({
  method: "delete",
  path: "/{id}/memories/{memoryId}",
  middleware: access.resource("project", "edit"),
  summary: "Delete one of a project's notes",
  description:
    "An optional `reason` is kept in the note's history, which outlives it.",
  tags: ["Projects"],
  request: {
    params: projectMemoryParamsSchema,
    query: deleteMemoryQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: memoryOkResponseSchema } },
      description: "The note, deleted",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteAllRoute = createRoute({
  method: "post",
  path: "/{id}/memories/delete-all",
  middleware: access.resource("project", "full"),
  summary: "Clear a project's notes",
  tags: ["Projects"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: deleteAllMemoriesResponseSchema },
      },
      description: "How many notes were deleted",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// HANDLERS             //
// ==================== //

projectMemoryRoutes.openapi(listRoute, async (c) => {
  const { limit, offset } = c.req.valid("query");
  const { memories, total } = await listProjectMemoriesForUi({
    organizationId: c.get("principal").organizationId,
    projectId: c.get("resource").node.id,
    limit,
    offset,
  });
  return c.json({ memories, total }, 200);
});

projectMemoryRoutes.openapi(getContentRoute, async (c) => {
  const { memoryId } = c.req.valid("param");
  const memory = await requireProjectMemoryContent({
    id: memoryId,
    organizationId: c.get("principal").organizationId,
    projectId: c.get("resource").node.id,
  });
  return c.json(memory, 200);
});

projectMemoryRoutes.openapi(getHistoryRoute, async (c) => {
  const { memoryId } = c.req.valid("param");
  const entries = await getProjectMemoryHistory({
    memoryId,
    organizationId: c.get("principal").organizationId,
    projectId: c.get("resource").node.id,
  });
  if (entries === null) {
    return throwHttpError(404, notFound("Memory file not found"));
  }
  return c.json({ entries }, 200);
});

projectMemoryRoutes.openapi(createNoteRoute, async (c) => {
  const scopeKey = projectScopeKey(c);
  const projectId = c.get("resource").node.id;
  await assertProjectNotArchived(projectId);
  const body = c.req.valid("json");

  // Without a path, one is suggested from the content, anchored on the
  // project's own folder conventions.
  let relativePath = body.path;
  if (!relativePath) {
    const { memories } = await listProjectMemoriesForUi({
      organizationId: scopeKey.organizationId,
      projectId,
      limit: 200,
      offset: 0,
    });
    relativePath = await suggestMemoryPath({
      scope: "project",
      content: body.content,
      scopeKey,
      existingPaths: memories.map((m) => m.path),
    });
  }

  const created = await createMemory({
    rawPath: formatMemoryPath({ scope: "project", relativePath }),
    content: body.content,
    scopeKey,
    actor: { actor: "human", userId: scopeKey.userId },
  });
  return c.json({ id: created.id }, 200);
});

projectMemoryRoutes.openapi(updateNoteRoute, async (c) => {
  const scopeKey = projectScopeKey(c);
  const { memoryId } = c.req.valid("param");
  const { content } = c.req.valid("json");
  const projectId = c.get("resource").node.id;
  const existing = await requireProjectMemoryContent({
    id: memoryId,
    organizationId: scopeKey.organizationId,
    projectId,
  });
  await assertProjectNotArchived(projectId);
  const result = await overwriteMemory({
    rawPath: formatMemoryPath({
      scope: "project",
      relativePath: existing.path,
    }),
    content,
    scopeKey,
    actor: { actor: "human", userId: scopeKey.userId },
  });
  return c.json({ ok: true as const, id: result.memory.id }, 200);
});

projectMemoryRoutes.openapi(deleteNoteRoute, async (c) => {
  const scopeKey = projectScopeKey(c);
  const { memoryId } = c.req.valid("param");
  const { reason } = c.req.valid("query");
  const projectId = c.get("resource").node.id;
  const existing = await requireProjectMemoryContent({
    id: memoryId,
    organizationId: scopeKey.organizationId,
    projectId,
  });
  await assertProjectNotArchived(projectId);
  await deleteMemory({
    rawPath: formatMemoryPath({
      scope: "project",
      relativePath: existing.path,
    }),
    scopeKey,
    actor: { actor: "human", userId: scopeKey.userId },
    reason,
  });
  return c.json({ ok: true as const }, 200);
});

projectMemoryRoutes.openapi(deleteAllRoute, async (c) => {
  const scopeKey = projectScopeKey(c);
  await assertProjectNotArchived(c.get("resource").node.id);
  const { deleted } = await deleteAllMemories({
    scopeKey,
    scope: "project",
    canManageTeamMemory: false,
    // `full` on the project: the route's rule.
    canManageProjectMemory: true,
  });
  return c.json({ deleted }, 200);
});

export { projectMemoryRoutes };
