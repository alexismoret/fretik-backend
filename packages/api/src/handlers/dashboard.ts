import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired, throwHttpError } from "@fretik/shared/lib/errors";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  dashboardActivityResponseSchema,
  dashboardAttentionResponseSchema,
  dashboardSummaryResponseSchema,
} from "@fretik/shared/schemas/dashboard";
import { getDashboardActivity } from "@fretik/shared/services/dashboard/get-activity";
import { getDashboardAttention } from "@fretik/shared/services/dashboard/get-attention";
import { getDashboardSummary } from "@fretik/shared/services/dashboard/get-summary";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

// ==================== //
// ROUTER SETUP         //
// ==================== //

const dashboardRoutes = new OpenAPIHono<HonoLoggedAppType>();
dashboardRoutes.use("*", authMiddleware);

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const summaryRoute = createRoute({
  method: "get",
  path: "/summary",
  summary: "Home dashboard summary",
  description:
    "Workspace KPIs for the home dashboard: total records with a 14-day sparkline, 7-day workflow-run volume and success rate, and this week's documents-processed series.",
  tags: ["Dashboard"],
  responses: {
    200: {
      content: {
        "application/json": { schema: dashboardSummaryResponseSchema },
      },
      description: "Dashboard summary retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const activityRoute = createRoute({
  method: "get",
  path: "/activity",
  summary: "Home dashboard recent activity",
  description:
    "The unified recent-activity feed, read from the durable journal (documents, records, catalog, files, apps, skills), newest first.",
  tags: ["Dashboard"],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(20).default(8),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: dashboardActivityResponseSchema },
      },
      description: "Recent activity retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const attentionRoute = createRoute({
  method: "get",
  path: "/attention",
  summary: "Home dashboard needs-attention inbox",
  description:
    "Workflow runs waiting on the user: those paused for an approval, then those that failed in the last week. Hides other users' private workflows.",
  tags: ["Dashboard"],
  responses: {
    200: {
      content: {
        "application/json": { schema: dashboardAttentionResponseSchema },
      },
      description: "Needs-attention inbox retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// ROUTE HANDLERS       //
// ==================== //

dashboardRoutes.openapi(summaryRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const summary = await getDashboardSummary({ teamId: team.id });

  return c.json(summary, 200);
});

dashboardRoutes.openapi(activityRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { limit } = c.req.valid("query");
  const activity = await getDashboardActivity({ teamId: team.id, limit });

  return c.json(activity, 200);
});

dashboardRoutes.openapi(attentionRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const attention = await getDashboardAttention({
    teamId: team.id,
    userId: user.id,
  });

  return c.json(attention, 200);
});

export { dashboardRoutes };
