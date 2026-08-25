import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import { createRedisRateLimitStore } from "@fretik/shared/lib/rate-limit";
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
  PageRunRequestSchema,
  PageRunResponseSchema,
  PageSummarySchema,
  ReportPageErrorRequestSchema,
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
import { appendPageRuntimeError } from "@fretik/shared/services/pages/report-runtime-error";
import { restorePageVersion } from "@fretik/shared/services/pages/restore";
import { getPage, listPages } from "@fretik/shared/services/pages/retrieve";
import { runPageOperation } from "@fretik/shared/services/pages/run-operation";
import { runPageData } from "@fretik/shared/services/pages/run-page-data";
import { updatePage } from "@fretik/shared/services/pages/update";
import { listPageVersions } from "@fretik/shared/services/pages/versions";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";

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

/**
 * Running an operation reaches a third party on the team's credentials, so it
 * is capped PER PERSON PER PAGE — a stuck button, a double-click storm or a
 * script cannot turn one page into a load generator, while two colleagues
 * working side by side never share a budget.
 *
 * This route is authenticated, and a published page may not carry operations
 * at all (`pagePublishError` refuses it), so no anonymous traffic reaches it.
 * The executor holds a second, per-connection budget; that one bounds the
 * third party, this one bounds the person.
 */
pageRoutes.use(
  "/:id/run",
  rateLimiter<HonoLoggedAppType>({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `${c.get("user").id}:${c.req.param("id") ?? ""}`,
    store: createRedisRateLimitStore<HonoLoggedAppType>("rl:page-run:"),
    requestPropertyName: "rateLimitPageRun",
  }),
);

/**
 * Runtime-error reports from the sandboxed page (via the parent bridge). The
 * SDK already dedupes per message per 5 s; this cap bounds a hostile or
 * looping page so the feed cannot become a write amplifier.
 */
pageRoutes.use(
  "/:id/errors",
  rateLimiter<HonoLoggedAppType>({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `${c.get("user").id}:${c.req.param("id") ?? ""}`,
    store: createRedisRateLimitStore<HonoLoggedAppType>("rl:page-errors:"),
    requestPropertyName: "rateLimitPageErrors",
  }),
);

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

const pageVersionSummarySchema = z.object({
  versionNumber: z.number().int(),
  operation: z.string(),
  byActor: z.string(),
  byUserId: z.string().nullable(),
  meta: z
    .object({
      round: z.number().int().optional(),
      score: z.number().optional(),
      restoredFrom: z.number().int().optional(),
    })
    .nullable(),
  createdAt: z.date(),
});

const versionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  summary: "List a page's saved states",
  description:
    "Newest first, up to the retention window. Definitions are omitted — fetch one version to read its source.",
  tags: ["Pages"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ versions: z.array(pageVersionSummarySchema) }),
        },
      },
      description: "Saved states",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const restoreVersionRoute = createRoute({
  method: "post",
  path: "/{id}/versions/{versionNumber}/restore",
  summary: "Put a page back into one of its saved states",
  description:
    "Records a NEW version whose content is the old one, so restoring is itself undoable. A version that no longer compiles is refused rather than saved.",
  tags: ["Pages"],
  request: {
    params: paramsIdSchema.extend({
      versionNumber: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            page: PageResponseSchema,
            restoredFrom: z.number().int(),
          }),
        },
      },
      description: "Restored page",
    },
    ...responseBadRequestSchema,
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
    "Runs under the CALLER's team scope. The body carries variable values, an optional dataset subset, and an optional window/ordering per dataset — never a filter, a collection or a query fragment, which all come from the stored definition. Datasets degrade individually (`forbidden`/`error`) instead of failing the request.",
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

const runRoute = createRoute({
  method: "post",
  path: "/{id}/run",
  summary: "Run one of a page's operations",
  description:
    "Executes a WRITE the page declares, against a connected app. The body names an operation id and carries variable values — never an action, a connection or an argument template, which all come from the stored definition. Answers 200 with a verdict (`ok` / `needs_connection` / `blocked` / `error`) rather than an HTTP error, so a page renders the outcome instead of a stack trace.",
  tags: ["Pages"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: PageRunRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PageRunResponseSchema } },
      description: "The operation's outcome",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const errorsRoute = createRoute({
  method: "post",
  path: "/{id}/errors",
  summary: "Report a page runtime error",
  description:
    "Appends one runtime error the sandboxed page reported through the bridge to the page's ring buffer (most recent kept). The buffer is the authoring agent's self-heal feed — it reads the tail on its next get/update and fixes what the browser saw.",
  tags: ["Pages"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: ReportPageErrorRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true) }) },
      },
      description: "Recorded",
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

pageRoutes.openapi(versionsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  // Through `getPage` so a private page's history is as private as the page.
  await getPage({ pageId: id, teamId: team.id, requester });
  const versions = await listPageVersions({ pageId: id, teamId: team.id });
  return c.json({ versions }, 200);
});

pageRoutes.openapi(restoreVersionRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id, versionNumber } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const restored = await restorePageVersion({
    pageId: id,
    teamId: team.id,
    versionNumber,
    actingUserId: user.id,
    requester,
  });
  return c.json(restored, 200);
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
      // And the viewer themselves: an external dataset resolved through a
      // personal connection makes the answer viewer-specific.
      userId: user.id,
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
        userId: user.id,
        variables,
        ...(datasetIds !== undefined ? { datasetIds } : {}),
        ...(queries !== undefined ? { queries } : {}),
        ...(fresh !== undefined ? { fresh } : {}),
      }),
  });
  return c.json(result, 200);
});

pageRoutes.openapi(runRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { operation, variables } = c.req.valid("json");
  const requester = await resolveRequester(user, team);

  const result = await runPageOperation({
    pageId: id,
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    requester,
    operation,
    variables,
  });
  return c.json(result, 200);
});

pageRoutes.openapi(errorsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const report = c.req.valid("json");
  const requester = await resolveRequester(user, team);
  await appendPageRuntimeError({
    pageId: id,
    teamId: team.id,
    requester,
    report,
  });
  return c.json({ ok: true as const }, 200);
});

export { pageRoutes };
