import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  CreatePageSchema,
  PageDataRequestSchema,
  PageDataResponseSchema,
  PageResponseSchema,
  PageSummarySchema,
  UpdatePageSchema,
} from "@fretik/shared/schemas/pages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { createPage } from "@fretik/shared/services/pages/create";
import {
  cachedPageData,
  pageDataCacheKey,
} from "@fretik/shared/services/pages/data-cache";
import { deletePage } from "@fretik/shared/services/pages/delete";
import {
  publishPage,
  unpublishPage,
} from "@fretik/shared/services/pages/publish";
import { getPage, listPages } from "@fretik/shared/services/pages/retrieve";
import { runPageData } from "@fretik/shared/services/pages/run-page-data";
import { updatePage } from "@fretik/shared/services/pages/update";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

/**
 * Pages — data-bound UI documents rendered deterministically from a stored
 * definition. Thin wrappers over `@fretik/shared/services/pages/*`: this file
 * resolves the caller's team + requester and formats responses, nothing more.
 *
 * Publishing is the only lifecycle gate; the anonymous side of a published
 * page lives in `public-pages.ts` (mounted at `/p`).
 */

const pageRoutes = new OpenAPIHono<HonoLoggedAppType>();
pageRoutes.use("*", authMiddleware);

/** A private (user-scoped) page is visible only to its owner — except org
 * admins/owners, who see every page for governance. */
const resolveRequester = async (
  user: { id: string },
  team: { organizationId: string },
): Promise<PageRequester> => ({
  userId: user.id,
  isAdmin: await isOrgAdmin(team.organizationId, user.id),
});

/** Writes answer with the page plus the sanitizer's warnings — the definition
 * is repaired rather than rejected, so the caller reads what was dropped. */
const pageWithWarningsSchema = z.object({
  page: PageResponseSchema,
  warnings: z.array(z.string()),
});

// ---- Routes ----------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List the team's pages",
  description:
    "Summaries only — node/dataset counts instead of the full tree. Newest-touched first.",
  tags: ["Pages"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(PageSummarySchema) }),
        },
      },
      description: "Pages",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  summary: "Create a page",
  description:
    "Always created unpublished. The definition is sanitized, not rejected: off-catalog props are dropped and reported as warnings.",
  tags: ["Pages"],
  request: {
    body: {
      content: { "application/json": { schema: CreatePageSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: pageWithWarningsSchema } },
      description: "Created page (+ sanitizer warnings)",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Fetch one page",
  tags: ["Pages"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: PageResponseSchema } },
      description: "Page",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a page",
  description:
    "Partial update; the definition, when present, replaces the previous tree wholesale. Editing a published page does NOT change what its public URL serves — publish again to refresh the snapshot.",
  tags: ["Pages"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: UpdatePageSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: pageWithWarningsSchema } },
      description: "Updated page (+ sanitizer warnings)",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a page",
  description:
    "Irreversible. A published token stops resolving immediately (its public cache is dropped).",
  tags: ["Pages"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Page deleted",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const publishRoute = createRoute({
  method: "post",
  path: "/{id}/publish",
  summary: "Publish a page at its public URL",
  description:
    "Snapshots the current definition into the public view and mints (or keeps) the token, so a shared link never breaks on re-publish. The DATA stays live under the owning team's scope.",
  tags: ["Pages"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: PageResponseSchema } },
      description: "Published page",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const unpublishRoute = createRoute({
  method: "post",
  path: "/{id}/unpublish",
  summary: "Revoke a page's public URL",
  description:
    "Clears the token and the frozen snapshot; the old link can never be reused.",
  tags: ["Pages"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: PageResponseSchema } },
      description: "Unpublished page",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const dataRoute = createRoute({
  method: "post",
  path: "/{id}/data",
  summary: "Execute a page's datasets",
  description:
    "Runs under the CALLER's team scope. The body carries variable values, an optional dataset subset, and an optional window/ordering per dataset — never a filter, an object type or a query fragment, which all come from the stored definition. Datasets degrade individually (`forbidden`/`error`) instead of failing the request.",
  tags: ["Pages"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: PageDataRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PageDataResponseSchema } },
      description: "Dataset results, keyed by dataset id",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

// ---- Handlers --------------------------------------------------------

pageRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const requester = await resolveRequester(user, team);
  const data = await listPages({ teamId: team.id, requester });
  return c.json({ data }, 200);
});

pageRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const { page, warnings } = await createPage({
    organizationId: team.organizationId,
    teamId: team.id,
    createdByUserId: user.id,
    input: body,
  });
  return c.json({ page, warnings }, 201);
});

pageRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const page = await getPage({ pageId: id, teamId: team.id, requester });
  return c.json(page, 200);
});

pageRoutes.openapi(updateRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const requester = await resolveRequester(user, team);
  const { page, warnings } = await updatePage({
    pageId: id,
    teamId: team.id,
    actingUserId: user.id,
    requester,
    input: body,
  });
  return c.json({ page, warnings }, 200);
});

pageRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  await deletePage({ pageId: id, teamId: team.id, requester });
  return c.json({ ok: true }, 200);
});

pageRoutes.openapi(publishRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const page = await publishPage({
    pageId: id,
    teamId: team.id,
    publishedByUserId: user.id,
    requester,
  });
  return c.json(page, 200);
});

pageRoutes.openapi(unpublishRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const page = await unpublishPage({
    pageId: id,
    teamId: team.id,
    requester,
  });
  return c.json(page, 200);
});

pageRoutes.openapi(dataRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { variables, datasetIds, queries, fresh } = c.req.valid("json");
  const requester = await resolveRequester(user, team);

  const page = await getPage({ pageId: id, teamId: team.id, requester });
  // Cached for 20 s per team + definition version + request, with concurrent
  // misses collapsed into one execution — a dashboard left open re-asks the
  // same aggregates on every glance. `fresh` is the refresh button's bypass.
  const result = await cachedPageData({
    key: pageDataCacheKey({
      pageId: id,
      // The VIEWER's team, which is also what scopes the queries below: a page
      // shared across teams shows each reader their own records, so a key
      // without the team would serve one team's rows to another.
      teamId: team.id,
      definitionFingerprint: page.updatedAt.toISOString(),
      request: { variables, datasetIds, queries },
    }),
    ...(fresh !== undefined ? { fresh } : {}),
    run: () =>
      // The VIEWER's team scopes the queries — never the page owner's. Only the
      // anonymous published route deliberately runs under the owner's scope.
      runPageData({
        definition: page.definition,
        teamId: team.id,
        variables,
        ...(datasetIds !== undefined ? { datasetIds } : {}),
        ...(queries !== undefined ? { queries } : {}),
      }),
  });
  return c.json(result, 200);
});

export { pageRoutes };
