import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  granteeListSchema,
  sharedRecordIdsSchema,
  sharedTypeIdsSchema,
} from "@fretik/shared/schemas/object-sharing";
import {
  listRecordShares,
  listSharedRecordIdsForType,
  listSharedTypeIds,
  listTypeGrants,
} from "@fretik/shared/services/object-sharing/list";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Object-sharing API — the READ side of the cross-team ACL layer (who a type /
 * record is shared with, plus the index-page sharing state). Writes go through
 * the single create/update path: `sharing` on `POST`/`PATCH /object-types` and
 * `/objects` reconciles `object_grants` / `record_shares` in the same
 * transaction, so there is no separate grant/share endpoint.
 */
const objectSharingRoutes = new OpenAPIHono<HonoLoggedAppType>();
objectSharingRoutes.use("*", authMiddleware);

const listTypeGrantsRoute = createRoute({
  method: "get",
  path: "/types/{id}/grants",
  summary: "List a type's grants",
  tags: ["ObjectSharing"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: granteeListSchema } },
      description: "Grants retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const listRecordSharesRoute = createRoute({
  method: "get",
  path: "/records/{id}/shares",
  summary: "List a record's shares",
  tags: ["ObjectSharing"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: granteeListSchema } },
      description: "Shares retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const sharedTypesRoute = createRoute({
  method: "get",
  path: "/types/shared",
  summary: "Sharing state of the team's types",
  description:
    "Returns the team's shared-out type ids and the type ids shared with the team (for badges + the 'Shared with me' filter).",
  tags: ["ObjectSharing"],
  responses: {
    200: {
      content: { "application/json": { schema: sharedTypeIdsSchema } },
      description: "Sharing state retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const sharedRecordsRoute = createRoute({
  method: "get",
  path: "/records/shared",
  summary: "Record ids of a type the team has shared out",
  tags: ["ObjectSharing"],
  request: { query: z.object({ objectTypeId: z.uuid() }) },
  responses: {
    200: {
      content: { "application/json": { schema: sharedRecordIdsSchema } },
      description: "Shared record ids retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

objectSharingRoutes.openapi(listTypeGrantsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  return c.json(await listTypeGrants(id), 200);
});

objectSharingRoutes.openapi(listRecordSharesRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  return c.json(await listRecordShares(id), 200);
});

objectSharingRoutes.openapi(sharedTypesRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const result = await listSharedTypeIds({
    organizationId: team.organizationId,
    teamId: team.id,
  });
  return c.json(result, 200);
});

objectSharingRoutes.openapi(sharedRecordsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { objectTypeId } = c.req.valid("query");
  const ids = await listSharedRecordIdsForType({
    teamId: team.id,
    objectTypeId,
  });
  return c.json(ids, 200);
});

export { objectSharingRoutes };
