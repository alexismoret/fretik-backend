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
  responseListSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  createObjectRecordRequestSchema,
  groupAggregateSchema,
  mapPointsResponseSchema,
  objectRecordListItemSchema,
  objectRecordResponseSchema,
  objectRecordWithLinksResponseSchema,
  recordAggregateQuerySchema,
  recordHistoryResponseSchema,
  recordListQuerySchema,
  recordMapQuerySchema,
  setRecordStatusRequestSchema,
  updateObjectRecordRequestSchema,
} from "@fretik/shared/schemas/ontology";
import { getRecordHistory } from "@fretik/shared/services/domain-events/history";
import { aggregateRecordsByGroup } from "@fretik/shared/services/object-records/aggregate-by-group";
import { createObjectRecord } from "@fretik/shared/services/object-records/create";
import { deleteObjectRecord } from "@fretik/shared/services/object-records/delete";
import { getMapPoints } from "@fretik/shared/services/object-records/map-points";
import {
  getObjectRecord,
  listObjectRecords,
} from "@fretik/shared/services/object-records/retrieve";
import { setRecordStatus } from "@fretik/shared/services/object-records/set-status";
import { setRecordData } from "@fretik/shared/services/object-records/update";
import { assertCanWriteRecord } from "@fretik/shared/services/object-sharing/write-access";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Object-records API — the typed rows of the workspace. Trust lives on
 * `status`: AI-fed records arrive `suggested` and the human confirms/rejects
 * them via the status route.
 */
const objectRecordRoutes = new OpenAPIHono<HonoLoggedAppType>();
objectRecordRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List records of a type",
  tags: ["ObjectRecords"],
  request: { query: recordListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(objectRecordListItemSchema),
        },
      },
      description: "Records retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const aggregateRoute = createRoute({
  method: "get",
  path: "/aggregate",
  summary: "Count (and optionally sum) records grouped by a field",
  tags: ["ObjectRecords"],
  request: { query: recordAggregateQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(groupAggregateSchema),
        },
      },
      description: "Group aggregates retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const mapRoute = createRoute({
  method: "get",
  path: "/map",
  summary: "Records placed on a map by a location field, scoped to a bbox",
  tags: ["ObjectRecords"],
  request: { query: recordMapQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: mapPointsResponseSchema } },
      description: "Points (or clusters when dense) in the viewport",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get a record with its links",
  tags: ["ObjectRecords"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: objectRecordWithLinksResponseSchema },
      },
      description: "Record retrieved",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const historyRoute = createRoute({
  method: "get",
  path: "/{id}/history",
  summary: "Get a record's activity timeline",
  description:
    "Folds the durable journal into the record's field history + event list.",
  tags: ["ObjectRecords"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: recordHistoryResponseSchema },
      },
      description: "History retrieved",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create a record",
  tags: ["ObjectRecords"],
  request: {
    body: {
      content: {
        "application/json": { schema: createObjectRecordRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: objectRecordResponseSchema },
      },
      description: "Record created",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Replace a record's data",
  tags: ["ObjectRecords"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: updateObjectRecordRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: objectRecordResponseSchema },
      },
      description: "Record updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const statusRoute = createRoute({
  method: "post",
  path: "/{id}/status",
  summary: "Confirm or reject a record",
  tags: ["ObjectRecords"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: setRecordStatusRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: objectRecordResponseSchema },
      },
      description: "Record status updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a record",
  tags: ["ObjectRecords"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ id: z.uuid() }) },
      },
      description: "Record deleted",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

objectRecordRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const {
    objectTypeId,
    status,
    search,
    filters,
    page,
    limit,
    sortBy,
    sortDir,
    withLinks,
    documentId,
  } = c.req.valid("query");
  const result = await listObjectRecords({
    teamId: team.id,
    objectTypeId,
    status,
    search,
    filters,
    page,
    limit,
    sortBy,
    sortDir,
    withLinks,
    documentId,
  });
  return c.json(result, 200);
});

objectRecordRoutes.openapi(aggregateRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { objectTypeId, groupKey, status, sumKey, sumKind } =
    c.req.valid("query");
  const groups = await aggregateRecordsByGroup({
    teamId: team.id,
    objectTypeId,
    groupKey,
    status,
    sumKey,
    sumKind,
  });
  return c.json({ count: groups.length, data: groups }, 200);
});

objectRecordRoutes.openapi(mapRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { objectTypeId, fieldKey, minLng, minLat, maxLng, maxLat } =
    c.req.valid("query");
  const bbox =
    minLng !== undefined &&
    minLat !== undefined &&
    maxLng !== undefined &&
    maxLat !== undefined
      ? { minLng, minLat, maxLng, maxLat }
      : undefined;
  const result = await getMapPoints({
    teamId: team.id,
    objectTypeId,
    fieldKey,
    bbox,
  });
  return c.json(result, 200);
});

objectRecordRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const record = await getObjectRecord({ id });
  return c.json(record, 200);
});

objectRecordRoutes.openapi(historyRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const history = await getRecordHistory({ recordId: id });
  return c.json(history, 200);
});

objectRecordRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const created = await createObjectRecord({
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    objectTypeId: body.objectTypeId,
    data: body.data,
    status: body.status,
    source: body.source ?? "user_manual",
    labelOverride: body.labelOverride ?? null,
    relations: body.relations,
    sharing: body.sharing,
    // Stamp created_by / last_edited_by with the acting user.
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(created, 201);
});

objectRecordRoutes.openapi(updateRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { data, sharing } = c.req.valid("json");
  await assertCanWriteRecord({
    recordId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  // `sharing` is owner-only — enforced inside the service via `callerTeamId`.
  const updated = await setRecordData({
    id,
    data,
    sharing,
    callerTeamId: team.id,
    // Stamp last_edited_by with the acting user.
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(updated, 200);
});

objectRecordRoutes.openapi(statusRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const { status } = c.req.valid("json");
  await assertCanWriteRecord({
    recordId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const updated = await setRecordStatus({ id, status });
  return c.json(updated, 200);
});

objectRecordRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  await assertCanWriteRecord({
    recordId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const result = await deleteObjectRecord({ id });
  return c.json(result, 200);
});

export { objectRecordRoutes };
