import { access, teamOfResource } from "@fretik/shared/authz/http";
import {
  requirePlacement,
  teamOfProject,
} from "@fretik/shared/authz/placement";
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
  PageConnectionsResponseSchema,
  PageDataRequestSchema,
  PageDataResponseSchema,
  PageResponseSchema,
  PageRunRequestSchema,
  PageRunResponseSchema,
  PageSummarySchema,
  ReportPageErrorRequestSchema,
  SetPageConnectionRequestSchema,
  UpdatePageSchema,
} from "@fretik/shared/schemas/pages";
import {
  bumpExternalConnectionsEpoch,
  externalConnectionsEpoch,
} from "@fretik/shared/services/external-apps/connections/epoch";
import { getConnectionForCaller } from "@fretik/shared/services/external-apps/connections/get-by-id";
import { buildPageConnectionReport } from "@fretik/shared/services/external-apps/connections/page-report";
import { setConnectionPreference } from "@fretik/shared/services/external-apps/connections/preference";
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
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Pages — data-bound UI documents rendered deterministically from a stored
 * definition. Thin wrappers over `@fretik/shared/services/pages/*`: this file
 * declares who may call each route, resolves the caller's team and formats
 * responses, nothing more.
 *
 * Each route on one page names the level it takes (`access.resource`): view
 * to open it, use to run its operations, edit to change it, full to delete,
 * publish or restrict it. The services filter with the same principal, so an
 * AI tool calling them directly meets the same rules.
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
  middleware: access.session(
    "The active team's pages the caller can see, or a project's (`projectId`, view on it): a restricted one only through its owner or a grant.",
  ),
  summary: "List the team's pages",
  description:
    "Summaries only — node/dataset counts instead of the full tree. Newest-touched first. `conversationId` keeps the pages that conversation built (their `sourceConversationId`) — what the chat header's Pages control lists. `projectId` keeps one project's, wherever the caller's team.",
  tags: ["Pages"],
  request: {
    query: z.object({
      conversationId: z.uuid().optional(),
      projectId: z.uuid().optional(),
    }),
  },
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
  middleware: access.handler(
    "Where it lands (`authz/placement.ts`): a project the caller takes part in (`projectId`), or the active team, which they contribute to.",
  ),
  summary: "Create a page",
  description:
    "Always created unpublished. The definition is sanitized, not rejected: off-catalog props are dropped and reported as warnings.",
  tags: ["Pages"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreatePageSchema.extend({ projectId: z.uuid().optional() }),
        },
      },
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
  middleware: access.resource("page", "view"),
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
  middleware: access.resource("page", "edit"),
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
  middleware: access.resource("page", "full"),
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
  middleware: access.resource("page", "view"),
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
  middleware: access.resource("page", "edit"),
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
  middleware: access.resource("page", "full"),
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
  middleware: access.resource("page", "full"),
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
  middleware: access.resource("page", "view"),
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

/** `/{id}/connections/{providerKey}` — the app, spelled as the catalogue does. */
const paramsIdProviderKeySchema = paramsIdSchema.extend({
  providerKey: z
    .string()
    .min(1)
    .max(80)
    .openapi({ example: "akanea-wms", description: "Connected app key" }),
});

const connectionsRoute = createRoute({
  method: "get",
  path: "/{id}/connections",
  middleware: access.resource("page", "view"),
  summary: "How this page's connected apps stand for the caller",
  description:
    "One entry per connected app the page reads or writes: which account the CALLER's view resolves to, why that one, every account they could switch to, and — when none resolves — whether nobody on the team has connected the app, whether the connection exists but is unusable, or whether the page pins a colleague's personal account. Runs no dataset.",
  tags: ["Pages"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: PageConnectionsResponseSchema },
      },
      description: "One state per connected app the page uses",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const setConnectionRoute = createRoute({
  method: "patch",
  path: "/{id}/connections/{providerKey}",
  middleware: access.resource("page", "view"),
  summary: "Choose which account this page reads through, for the caller only",
  description:
    "Stores the caller's own choice among the accounts they may use for one app on one page — it never changes what a colleague sees, and a connection the page PINS still wins. `connectionId: null` clears the choice and hands the page back to the automatic pick (the caller's own account, else the team's).",
  tags: ["Pages"],
  request: {
    params: paramsIdProviderKeySchema,
    body: {
      content: {
        "application/json": { schema: SetPageConnectionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: PageConnectionsResponseSchema },
      },
      description: "The page's connection states after the change",
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
  middleware: access.resource("page", "use"),
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
  middleware: access.resource("page", "view"),
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
  const principal = c.get("principal");
  const { conversationId, projectId } = c.req.valid("query");
  const teamId =
    projectId === undefined
      ? c.get("team")?.id
      : await teamOfProject(principal, projectId);
  if (!teamId) return c.json(teamRequired(), 403);
  const data = await listPages({
    teamId,
    principal,
    ...(conversationId === undefined
      ? {}
      : { sourceConversationId: conversationId }),
    ...(projectId === undefined ? {} : { projectId }),
  });
  return c.json({ data }, 200);
});

pageRoutes.openapi(createRouteDef, async (c) => {
  const principal = c.get("principal");
  const user = c.get("user");
  const { projectId, ...input } = c.req.valid("json");
  const placement = await requirePlacement({
    principal,
    activeTeamId: c.get("team")?.id,
    projectId,
  });
  const { page, warnings } = await createPage({
    organizationId: principal.organizationId,
    teamId: placement.teamId,
    projectId: placement.projectId,
    createdByUserId: user.id,
    input,
  });
  return c.json({ page, warnings }, 201);
});

pageRoutes.openapi(getRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const page = await getPage({
    pageId: id,
    teamId,
    principal: c.get("principal"),
  });
  return c.json(page, 200);
});

pageRoutes.openapi(updateRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const { page, warnings } = await updatePage({
    pageId: id,
    teamId,
    actingUserId: c.get("user").id,
    principal: c.get("principal"),
    input: body,
  });
  return c.json({ page, warnings }, 200);
});

pageRoutes.openapi(deleteRouteDef, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  await deletePage({
    pageId: id,
    teamId,
    principal: c.get("principal"),
  });
  return c.json({ ok: true }, 200);
});

pageRoutes.openapi(versionsRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  // Through `getPage` so a restricted page's history is as closed as the page.
  await getPage({ pageId: id, teamId, principal: c.get("principal") });
  const versions = await listPageVersions({ pageId: id, teamId });
  return c.json({ versions }, 200);
});

pageRoutes.openapi(restoreVersionRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id, versionNumber } = c.req.valid("param");
  const restored = await restorePageVersion({
    pageId: id,
    teamId,
    versionNumber,
    actingUserId: c.get("user").id,
    principal: c.get("principal"),
  });
  return c.json(restored, 200);
});

pageRoutes.openapi(publishRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const page = await publishPage({
    pageId: id,
    teamId,
    publishedByUserId: c.get("user").id,
    principal: c.get("principal"),
  });
  return c.json(page, 200);
});

pageRoutes.openapi(unpublishRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const page = await unpublishPage({
    pageId: id,
    teamId,
    principal: c.get("principal"),
  });
  return c.json(page, 200);
});

pageRoutes.openapi(dataRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { variables, datasetIds, queries, fresh } = c.req.valid("json");

  const page = await getPage({
    pageId: id,
    teamId,
    principal: c.get("principal"),
  });
  // Cached for 20 s per reader + definition version + request, with concurrent
  // misses collapsed into one execution — a dashboard left open re-asks the
  // same aggregates on every glance. `fresh` is the refresh button's bypass.
  const connectionsEpoch = await externalConnectionsEpoch({
    teamId,
    userId: user.id,
  });
  const result = await cachedPageData({
    key: pageDataCacheKey({
      pageId: id,
      // The page's team, which scopes the queries below…
      teamId,
      // …read as the viewer: they are shown what they may read there. An
      // external dataset reads through the team's connections, as the
      // published page does, or through one of the viewer's own.
      userId: user.id,
      definitionFingerprint: page.updatedAt.toISOString(),
      connectionsEpoch,
      request: { variables, datasetIds, queries },
    }),
    ...(fresh !== undefined ? { fresh } : {}),
    run: async () => {
      // The page's own team scopes the queries, read as the viewer — never as
      // its owner: a page shared from another team shows its data as far as
      // the viewer may read it. Only the anonymous published route runs as
      // the team's agent.
      const data = await runPageData({
        definition: page.definition,
        teamId,
        userId: user.id,
        reader: c.get("principal"),
        pageId: id,
        variables,
        ...(datasetIds !== undefined ? { datasetIds } : {}),
        ...(queries !== undefined ? { queries } : {}),
        ...(fresh !== undefined ? { fresh } : {}),
      });
      // Rides along with the data it explains, so the banner and the datasets
      // can never disagree about what happened. Cached with it too — the key
      // carries the connections epoch, so connecting an app retires both.
      const connections = await buildPageConnectionReport({
        definition: page.definition,
        teamId,
        userId: user.id,
        pageId: id,
      });
      return connections.length > 0 ? { ...data, connections } : data;
    },
  });
  return c.json(result, 200);
});

pageRoutes.openapi(connectionsRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");

  const page = await getPage({
    pageId: id,
    teamId,
    principal: c.get("principal"),
  });
  const connections = await buildPageConnectionReport({
    definition: page.definition,
    teamId,
    userId: c.get("user").id,
    pageId: id,
  });
  return c.json({ connections }, 200);
});

pageRoutes.openapi(setConnectionRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { organizationId } = c.get("principal");
  const user = c.get("user");
  const { id, providerKey } = c.req.valid("param");
  const { connectionId } = c.req.valid("json");

  // Seeing the page is the right to choose how YOU read it — the choice is
  // per-user and changes nothing for anyone else.
  const page = await getPage({
    pageId: id,
    teamId,
    principal: c.get("principal"),
  });
  if (connectionId !== null) {
    // Throws 404 when the connection is not one this caller may use, which is
    // the whole authorisation check: `setConnectionPreference` writes, it does
    // not authorise.
    await getConnectionForCaller(connectionId, teamId, user.id);
  }
  await setConnectionPreference({
    organizationId,
    teamId,
    userId: user.id,
    providerKey,
    pageId: id,
    connectionId,
  });
  // The viewer's cached page data resolved through the OLD account.
  await bumpExternalConnectionsEpoch({ teamId, userId: user.id });

  const connections = await buildPageConnectionReport({
    definition: page.definition,
    teamId,
    userId: user.id,
    pageId: id,
  });
  return c.json({ connections }, 200);
});

pageRoutes.openapi(runRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { organizationId } = c.get("principal");
  const { id } = c.req.valid("param");
  const { operation, variables } = c.req.valid("json");

  const result = await runPageOperation({
    pageId: id,
    organizationId,
    teamId,
    userId: c.get("user").id,
    principal: c.get("principal"),
    operation,
    variables,
  });
  return c.json(result, 200);
});

pageRoutes.openapi(errorsRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  await appendPageRuntimeError({
    pageId: id,
    teamId,
    principal: c.get("principal"),
    report: c.req.valid("json"),
  });
  return c.json({ ok: true as const }, 200);
});

export { pageRoutes };
