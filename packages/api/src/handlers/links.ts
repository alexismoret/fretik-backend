import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  createLinkRequestSchema,
  linkResponseSchema,
  recordLinksResponseSchema,
} from "@fretik/shared/schemas/ontology";
import { createLink } from "@fretik/shared/services/links/create";
import { invalidateLink } from "@fretik/shared/services/links/invalidate";
import { listLinksForRecord } from "@fretik/shared/services/links/retrieve";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Links API — the typed edges between records. A link is confirmed by
 * existence; removing a relation invalidates the edge (non-destructive).
 */
const linkRoutes = new OpenAPIHono<HonoLoggedAppType>();
linkRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List a record's active links",
  tags: ["Links"],
  request: { query: z.object({ recordId: z.uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: recordLinksResponseSchema },
      },
      description: "Links retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create a link between two records",
  tags: ["Links"],
  request: {
    body: {
      content: { "application/json": { schema: createLinkRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: linkResponseSchema } },
      description: "Link created",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Remove a link",
  tags: ["Links"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: linkResponseSchema } },
      description: "Link removed",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

linkRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { recordId } = c.req.valid("query");
  const links = await listLinksForRecord({ recordId });
  return c.json(links, 200);
});

linkRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const body = c.req.valid("json");
  const created = await createLink({
    organizationId: team.organizationId,
    teamId: team.id,
    linkTypeId: body.linkTypeId,
    fromRecordId: body.fromRecordId,
    toRecordId: body.toRecordId,
    props: body.props,
  });
  return c.json(created, 201);
});

linkRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const invalidated = await invalidateLink({ id });
  return c.json(invalidated, 200);
});

export { linkRoutes };
