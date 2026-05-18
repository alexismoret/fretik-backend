import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import { paramsListSchema } from "@fretik/shared/schemas/common/params";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import { listTeamLabels } from "@fretik/shared/services/labels/retrieve";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Minimal labels API — just lists the team's labels with `paramsListSchema`
 * for search/page/limit (shared schema cap = 50/page). The label picker on
 * the document detail panel + the drive label filter both call this.
 *
 * Full CRUD (create / update / delete) will land in a follow-up; existing
 * label rows are created via DB seeds for now.
 */

const labelRoutes = new OpenAPIHono<HonoLoggedAppType>();
labelRoutes.use("*", authMiddleware);

const labelResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
});

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List team labels",
  tags: ["Labels"],
  request: { query: paramsListSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(labelResponseSchema) },
      },
      description: "Labels retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

labelRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { search, page, limit } = c.req.valid("query");
  const labels = await listTeamLabels({
    teamId: team.id,
    search,
    limit,
    offset: page * limit,
  });
  return c.json(labels, 200);
});

export { labelRoutes };
