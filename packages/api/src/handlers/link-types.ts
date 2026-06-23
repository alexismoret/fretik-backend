import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  createLinkTypeRequestSchema,
  linkTypeResponseSchema,
} from "@fretik/shared/schemas/ontology";
import { createLinkType } from "@fretik/shared/services/link-types/create";
import { listLinkTypes } from "@fretik/shared/services/link-types/retrieve";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Link-types API — the relation catalog. A team defines a typed relation
 * ("Company → vendor → Company") once; records then link through it.
 */
const linkTypeRoutes = new OpenAPIHono<HonoLoggedAppType>();
linkTypeRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List relation types",
  tags: ["LinkTypes"],
  request: {
    query: z.object({ fromObjectTypeId: z.uuid().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(linkTypeResponseSchema) },
      },
      description: "Relation types retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create a relation type",
  tags: ["LinkTypes"],
  request: {
    body: {
      content: { "application/json": { schema: createLinkTypeRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: linkTypeResponseSchema } },
      description: "Relation type created",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

linkTypeRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { fromObjectTypeId } = c.req.valid("query");
  const types = await listLinkTypes({
    organizationId: team.organizationId,
    teamId: team.id,
    fromObjectTypeId,
  });
  return c.json(types, 200);
});

linkTypeRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const body = c.req.valid("json");
  const created = await createLinkType({
    organizationId: team.organizationId,
    teamId: team.id,
    key: body.key,
    label: body.label,
    fromObjectTypeId: body.fromObjectTypeId,
    toObjectTypeId: body.toObjectTypeId ?? null,
    inverseKey: body.inverseKey ?? null,
    inverseLabel: body.inverseLabel ?? null,
    cardinality: body.cardinality,
  });
  return c.json(created, 201);
});

export { linkTypeRoutes };
