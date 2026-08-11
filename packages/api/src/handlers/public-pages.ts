import db from "@fretik/shared/db";
import { type HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import {
  clientIp,
  createRedisRateLimitStore,
} from "@fretik/shared/lib/rate-limit";
import { selectOrCache } from "@fretik/shared/lib/redis";
import { responseInternalErrorSchema } from "@fretik/shared/schemas/common/responses";
import {
  PageDataRequestSchema,
  PageDataResponseSchema,
  PublicPageResponseSchema,
  type PublicPageResponse,
} from "@fretik/shared/schemas/pages";
import {
  hashPageDataRequest,
  PUBLIC_PAGE_CACHE_TTL,
  publicPageDataCacheKey,
  publicPageDefinitionCacheKey,
} from "@fretik/shared/services/pages/public-cache";
import { resolvePageAccess } from "@fretik/shared/services/pages/resolve-page-access";
import { runPageData } from "@fretik/shared/services/pages/run-page-data";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Public page routes — the anonymous ingress for a published page's
 * `/p/<token>` URL. Intentionally UNAUTHENTICATED (no `authMiddleware`,
 * mirrors `public-forms.ts`): publishing IS the decision to expose, and
 * unpublishing clears the token so a revoked link is indistinguishable from
 * one that never existed.
 *
 * Both routes ALWAYS answer 200 with an `access` verdict. A missing, deleted
 * or unpublished page must not be distinguishable by status code, and a 401/404
 * here would trip the frontend's global 401 → /login redirect on a page that is
 * meant to be readable while signed out.
 *
 * SECURITY — the request body carries ONLY variable values. Every object type,
 * filter key and operator comes from the stored (frozen) definition, so an
 * anonymous caller cannot widen the query: unknown variable keys are dropped
 * and the executor never reads a type id, filter or query fragment from the
 * request. Filters, object type ids and SQL must NEVER be accepted from the
 * request under any circumstance.
 *
 * Redis caches both endpoints behind short TTLs (definition 5 min, data 60 s
 * per variable combination) so a link shared to a crowd doesn't turn every view
 * into a fresh aggregate query. Publish/unpublish/delete drop the whole token
 * prefix, so a revoked link goes dark at once.
 */
const publicPageRoutes = new OpenAPIHono<HonoLoggedAppType>();

const NOT_FOUND: PublicPageResponse = { access: "not_found" };

const tokenParamSchema = z.object({ token: z.string().min(1) });

/** The token column is a uuid: a malformed token can never match a row, and
 * must answer `not_found` rather than reach Postgres (or 400 the caller). */
const isUuidToken = (token: string): boolean =>
  z.uuid().safeParse(token).success;

// Anti-abuse on top of the app-wide limiter: a per-IP burst cap + a per-token
// global cap. Distinct `requestPropertyName`s + store prefixes so the two
// coexist. Redis-backed → shared across instances.
const perIpLimiter = (limit: number, prefix: string, property: string) =>
  rateLimiter({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `ip:${clientIp(c)}`,
    store: createRedisRateLimitStore(prefix),
    requestPropertyName: property,
  });

const perTokenLimiter = (limit: number, prefix: string, property: string) =>
  rateLimiter({
    windowMs: 60 * 60_000,
    limit,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `page:${c.req.param("token") ?? "unknown"}`,
    store: createRedisRateLimitStore(prefix),
    requestPropertyName: property,
  });

publicPageRoutes.use(
  "/:token",
  perIpLimiter(60, "rl:page-ip:", "rateLimitPageIp"),
  perTokenLimiter(2000, "rl:page-cap:", "rateLimitPageCap"),
);

publicPageRoutes.use(
  "/:token/data",
  perIpLimiter(30, "rl:page-data-ip:", "rateLimitPageDataIp"),
  perTokenLimiter(1000, "rl:page-data-cap:", "rateLimitPageDataCap"),
);

// ==================== //
// GET page definition  //
// ==================== //

const getPageRoute = createRoute({
  method: "get",
  path: "/{token}",
  summary: "Public definition + access verdict for a published page",
  description:
    "Always 200. Serves the definition FROZEN at publish time, never the team's working copy.",
  tags: ["Pages"],
  request: { params: tokenParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: PublicPageResponseSchema } },
      description: "Access verdict (+ the page when access is `ready`)",
    },
    ...responseInternalErrorSchema,
  },
});

publicPageRoutes.openapi(getPageRoute, async (c) => {
  const { token } = c.req.valid("param");
  if (!isUuidToken(token)) return c.json(NOT_FOUND, 200);

  const payload = await selectOrCache<PublicPageResponse>(
    async () => {
      const result = await resolvePageAccess({ token });
      if (result.access !== "ready") return NOT_FOUND;

      const [org, team] = await Promise.all([
        db.query.organization.findFirst({
          where: { id: result.page.organizationId },
          columns: { name: true, logo: true },
        }),
        db.query.team.findFirst({
          where: { id: result.page.teamId },
          columns: { name: true },
        }),
      ]);

      return {
        access: "ready",
        page: {
          name: result.page.name,
          description: result.page.description,
          icon: result.page.icon,
          color: result.page.color,
          definition: result.definition,
          organizationName: org?.name ?? "",
          organizationLogo: org?.logo ?? null,
          teamName: team?.name ?? "",
        },
      };
    },
    publicPageDefinitionCacheKey(token),
    PUBLIC_PAGE_CACHE_TTL.definition,
  );

  return c.json(payload, 200);
});

// ==================== //
// POST page data       //
// ==================== //

const publicPageDataResponseSchema = z.object({
  access: PublicPageResponseSchema.shape.access,
  datasets: PageDataResponseSchema.shape.datasets.optional(),
});

const postDataRoute = createRoute({
  method: "post",
  path: "/{token}/data",
  summary: "Execute a published page's datasets",
  description:
    "Always 200. Runs under the OWNING team's scope (that is what makes a public page show real numbers) against the FROZEN definition. The body carries variable values, an optional dataset subset, and an optional window/ordering per dataset — never filters, object type ids or query fragments.",
  tags: ["Pages"],
  request: {
    params: tokenParamSchema,
    body: {
      content: { "application/json": { schema: PageDataRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: publicPageDataResponseSchema },
      },
      description: "Access verdict (+ dataset results when access is `ready`)",
    },
    ...responseInternalErrorSchema,
  },
});

publicPageRoutes.openapi(postDataRoute, async (c) => {
  const { token } = c.req.valid("param");
  if (!isUuidToken(token)) return c.json({ access: "not_found" as const }, 200);

  // `fresh` is deliberately NOT read here. On the authenticated route it is a
  // refresh button; on a link anyone can open it would be a switch that puts
  // the owner's database back in front of a crowd.
  const { variables, datasetIds, queries } = c.req.valid("json");
  const result = await resolvePageAccess({ token });
  if (result.access !== "ready") {
    return c.json({ access: "not_found" as const }, 200);
  }

  // Cached per REQUEST combination so flipping a filter chip — or turning a
  // table's page — stays snappy while the numbers stay honest (60 s). The hash
  // covers the window and ordering too: two viewers on different pages of the
  // same table must never share an entry.
  const data = await selectOrCache(
    () =>
      runPageData({
        // The frozen snapshot — edits made since publishing never reach an
        // anonymous viewer.
        definition: result.definition,
        // OWNER scope, deliberately: an anonymous viewer has no team, and the
        // published definition is the security boundary.
        teamId: result.page.teamId,
        variables,
        ...(datasetIds !== undefined ? { datasetIds } : {}),
        ...(queries !== undefined ? { queries } : {}),
      }),
    publicPageDataCacheKey(
      token,
      hashPageDataRequest({ variables, datasetIds, queries }),
    ),
    PUBLIC_PAGE_CACHE_TTL.data,
  );

  return c.json({ access: "ready" as const, datasets: data.datasets }, 200);
});

export { publicPageRoutes };
