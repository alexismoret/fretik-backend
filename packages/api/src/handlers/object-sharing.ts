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
  granteeListSchema,
  revokeResultSchema,
  sharedRecordIdsSchema,
  sharedTypeIdsSchema,
  shareRequestSchema,
  unshareRequestSchema,
} from "@fretik/shared/schemas/object-sharing";
import {
  grantObjectType,
  revokeObjectType,
} from "@fretik/shared/services/object-sharing/grant-type";
import {
  listRecordShares,
  listSharedRecordIdsForType,
  listSharedTypeIds,
  listTypeGrants,
} from "@fretik/shared/services/object-sharing/list";
import {
  shareRecord,
  unshareRecord,
} from "@fretik/shared/services/object-sharing/share-record";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Object-sharing API — the cross-team ACL layer. The owning team (and its
 * organization) come from the session; the body only carries the grantee
 * (`null` = org-wide) and permission. A team may only share types/records it
 * owns (enforced in the service layer).
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

const grantTypeRoute = createRoute({
  method: "post",
  path: "/types/{id}/grant",
  summary: "Share a type with a team (or org-wide)",
  tags: ["ObjectSharing"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: shareRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: granteeListSchema } },
      description: "Type shared; returns the updated grant list",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const revokeTypeRoute = createRoute({
  method: "post",
  path: "/types/{id}/revoke",
  summary: "Stop sharing a type with a team (or org-wide)",
  tags: ["ObjectSharing"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: unshareRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: revokeResultSchema } },
      description: "Grant revoked",
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

const shareRecordRoute = createRoute({
  method: "post",
  path: "/records/{id}/share",
  summary: "Share a record with a team (or org-wide)",
  tags: ["ObjectSharing"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: shareRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: granteeListSchema } },
      description: "Record shared; returns the updated share list",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const unshareRecordRoute = createRoute({
  method: "post",
  path: "/records/{id}/unshare",
  summary: "Stop sharing a record with a team (or org-wide)",
  tags: ["ObjectSharing"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: unshareRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: revokeResultSchema } },
      description: "Share revoked",
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

objectSharingRoutes.openapi(grantTypeRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  await grantObjectType({
    organizationId: team.organizationId,
    objectTypeId: id,
    ownerTeamId: team.id,
    granteeTeamId: body.granteeTeamId,
    permission: body.permission,
    createdByUserId: user.id,
  });
  return c.json(await listTypeGrants(id), 200);
});

objectSharingRoutes.openapi(revokeTypeRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await revokeObjectType({
    objectTypeId: id,
    granteeTeamId: body.granteeTeamId,
  });
  return c.json(result, 200);
});

objectSharingRoutes.openapi(listRecordSharesRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  return c.json(await listRecordShares(id), 200);
});

objectSharingRoutes.openapi(shareRecordRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  await shareRecord({
    organizationId: team.organizationId,
    recordId: id,
    ownerTeamId: team.id,
    granteeTeamId: body.granteeTeamId,
    permission: body.permission,
    createdByUserId: user.id,
  });
  return c.json(await listRecordShares(id), 200);
});

objectSharingRoutes.openapi(unshareRecordRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await unshareRecord({
    recordId: id,
    granteeTeamId: body.granteeTeamId,
  });
  return c.json(result, 200);
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
