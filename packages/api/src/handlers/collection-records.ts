import { access } from "@fretik/shared/authz/http";
import type { UserPrincipal } from "@fretik/shared/authz/principal";
import { requireSharingAudience } from "@fretik/shared/authz/sharing-policy";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import {
  beginBulkOperationRequestSchema,
  bulkOperationChunkRequestSchema,
  bulkOperationChunkResponseSchema,
  bulkOperationResponseSchema,
  bulkRecordWriteRequestSchema,
  bulkRecordWriteResponseSchema,
} from "@fretik/shared/schemas/bulk-operations";
import {
  audienceReach,
  type RecordSharing,
} from "@fretik/shared/schemas/collection-sharing";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  nextCursorSchema,
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseListSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  collectionRecordListItemSchema,
  collectionRecordResponseSchema,
  collectionRecordWithLinksResponseSchema,
  createCollectionRecordRequestSchema,
  groupAggregateSchema,
  mapPointsResponseSchema,
  recordAggregateQuerySchema,
  recordHistoryQuerySchema,
  recordHistoryResponseSchema,
  recordListQuerySchema,
  recordMapQuerySchema,
  setRecordStatusRequestSchema,
  updateCollectionRecordRequestSchema,
} from "@fretik/shared/schemas/ontology";
import {
  beginApiLoad,
  commitApiLoad,
  findTeamBulkOperation,
  serializeApiLoad,
  uploadApiChunk,
} from "@fretik/shared/services/bulk-operations/api-load";
import { listDoneChunkIndexes } from "@fretik/shared/services/bulk-operations/begin";
import { aggregateRecordsByGroup } from "@fretik/shared/services/collection-records/aggregate-by-group";
import { bulkCreateCollectionRecords } from "@fretik/shared/services/collection-records/bulk-create";
import { bulkDeleteCollectionRecords } from "@fretik/shared/services/collection-records/bulk-delete";
import { bulkUpdateCollectionRecords } from "@fretik/shared/services/collection-records/bulk-update";
import { createCollectionRecord } from "@fretik/shared/services/collection-records/create";
import { deleteCollectionRecord } from "@fretik/shared/services/collection-records/delete";
import { idsInCollection } from "@fretik/shared/services/collection-records/ids-in-collection";
import { getMapPoints } from "@fretik/shared/services/collection-records/map-points";
import {
  getCollectionRecord,
  listCollectionRecords,
} from "@fretik/shared/services/collection-records/retrieve";
import { setRecordStatus } from "@fretik/shared/services/collection-records/set-status";
import { setRecordData } from "@fretik/shared/services/collection-records/update";
import { assertCanReadRecord } from "@fretik/shared/services/collection-sharing/read-access";
import {
  assertCanWriteRecord,
  assertCanWriteType,
} from "@fretik/shared/services/collection-sharing/write-access";
import { getRecordHistory } from "@fretik/shared/services/domain-events/history";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Object-records API — the typed rows of the workspace. Trust lives on
 * `status`: AI-fed records arrive `suggested` and the human confirms/rejects
 * them via the status route.
 */
const collectionRecordRoutes = new OpenAPIHono<HonoLoggedAppType>();
collectionRecordRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "",
  middleware: access.session(
    "Rows of the collection the team may see: its own, granted, or shared one by one.",
  ),
  summary: "List records of a type",
  tags: ["CollectionRecords"],
  request: { query: recordListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(collectionRecordListItemSchema).extend({
            // Only on `paginate=cursor`, where `count` is not computed.
            nextCursor: nextCursorSchema.optional(),
          }),
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
  middleware: access.session(
    "Aggregates over the rows the team may see, by the same scope as the list.",
  ),
  summary: "Count (and optionally sum) records grouped by a field",
  tags: ["CollectionRecords"],
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
  middleware: access.session(
    "Map points of the rows the team may see, by the same scope as the list.",
  ),
  summary: "Records placed on a map by a location field, scoped to a bbox",
  tags: ["CollectionRecords"],
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
  middleware: access.handler(
    "The record must be readable by the team (getCollectionRecord); far ends are filtered.",
  ),
  summary: "Get a record with its links",
  tags: ["CollectionRecords"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: collectionRecordWithLinksResponseSchema },
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
  middleware: access.handler(
    "The record must be readable by the team (assertCanReadRecord).",
  ),
  summary: "Get a record's activity timeline",
  description:
    "Folds the durable journal into the record's field history + event list. Newest first, one page at a time — walk older with `cursor`.",
  tags: ["CollectionRecords"],
  request: { params: paramsIdSchema, query: recordHistoryQuerySchema },
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
  middleware: access.handler(
    "A collection the team may write records into (assertCanWriteType); sharing policies.",
  ),
  summary: "Create a record",
  tags: ["CollectionRecords"],
  request: {
    body: {
      content: {
        "application/json": { schema: createCollectionRecordRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: collectionRecordResponseSchema },
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
  middleware: access.handler(
    "Write access to the record (assertCanWriteRecord); its sharing is the owner team's.",
  ),
  summary: "Replace a record's data",
  tags: ["CollectionRecords"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: updateCollectionRecordRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: collectionRecordResponseSchema },
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
  middleware: access.handler(
    "Write access to the record (assertCanWriteRecord).",
  ),
  summary: "Confirm or reject a record",
  tags: ["CollectionRecords"],
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
        "application/json": { schema: collectionRecordResponseSchema },
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
  middleware: access.handler(
    "Write access to the record (assertCanWriteRecord).",
  ),
  summary: "Delete a record",
  tags: ["CollectionRecords"],
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

// ── Bulk writes ──────────────────────────────────────────────────────────
//
// One door for a load that fits a request, another for one that does not. The
// second is the same ledger the sandbox SDK uploads against — announce with a
// digest, send numbered chunks, commit — so a client that drops its connection
// re-runs the identical call and is told which chunks to skip.

const bulkWriteRoute = createRoute({
  method: "post",
  path: "/bulk",
  middleware: access.handler(
    "A collection the team may write records into (assertCanWriteType).",
  ),
  summary: "Create, update or delete many records in one request",
  description:
    "Up to 5 000 rows. Rows that fail come back in `errors` — the call is a partial success, not an all-or-nothing transaction. Past 5 000 rows, open a bulk operation instead.",
  tags: ["CollectionRecords"],
  request: {
    body: {
      content: {
        "application/json": { schema: bulkRecordWriteRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: bulkRecordWriteResponseSchema },
      },
      description: "Rows written",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const beginBulkOperationRoute = createRoute({
  method: "post",
  path: "/bulk-operations",
  middleware: access.handler(
    "The collection must be the team's own (beginApiLoad checks it).",
  ),
  summary: "Open (or re-find) a load too large for one request",
  description:
    "Announces the load without carrying a row. Idempotent on the load's description plus `rowsDigest`: re-submitting returns the same operation and the chunks already received.",
  tags: ["CollectionRecords"],
  request: {
    body: {
      content: {
        "application/json": { schema: beginBulkOperationRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: bulkOperationResponseSchema },
      },
      description: "Operation opened or resumed",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const bulkOperationChunkRoute = createRoute({
  method: "post",
  path: "/bulk-operations/{id}/chunks",
  middleware: access.handler(
    "The operation must be one the active team started.",
  ),
  summary: "Upload one numbered chunk of a load",
  description:
    "Applied on arrival. Re-sending a chunk already received is a no-op, not a second write.",
  tags: ["CollectionRecords"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: bulkOperationChunkRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: bulkOperationChunkResponseSchema },
      },
      description: "Chunk applied",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const commitBulkOperationRoute = createRoute({
  method: "post",
  path: "/bulk-operations/{id}/commit",
  middleware: access.handler(
    "The operation must be one the active team started.",
  ),
  summary: "Close a load and get its tally",
  description:
    "Refused while a chunk is missing — a load that wrote 198 000 of 200 000 rows must say so rather than report success.",
  tags: ["CollectionRecords"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: bulkOperationResponseSchema },
      },
      description: "Load closed",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getBulkOperationRoute = createRoute({
  method: "get",
  path: "/bulk-operations/{id}",
  middleware: access.handler(
    "The operation must be one the active team started.",
  ),
  summary: "Read a load's state and counters",
  tags: ["CollectionRecords"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: bulkOperationResponseSchema },
      },
      description: "Operation retrieved",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

/**
 * A record shared on its own (not inheriting its collection's sharing) must
 * stay within the organization's sharing policies, like any other share.
 */
const assertRecordSharingAllowed = async (
  principal: UserPrincipal,
  teamId: string,
  sharing: RecordSharing | undefined,
): Promise<void> => {
  if (sharing === undefined || sharing.inherit) return;
  await requireSharingAudience({
    principal,
    resourceTeamId: teamId,
    audience: audienceReach(sharing.audience, teamId),
  });
};

collectionRecordRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const {
    collectionId,
    status,
    search,
    filters,
    page,
    limit,
    sortBy,
    sortDir,
    withLinks,
    documentId,
    paginate,
    cursor,
  } = c.req.valid("query");
  const result = await listCollectionRecords({
    teamId: team.id,
    collectionId,
    status,
    search,
    filters,
    page,
    limit,
    sortBy,
    sortDir,
    withLinks,
    documentId,
    paginate,
    ...(cursor ? { cursor } : {}),
  });
  return c.json(result, 200);
});

collectionRecordRoutes.openapi(aggregateRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { collectionId, groupKey, status, sumKey, sumKind } =
    c.req.valid("query");
  const groups = await aggregateRecordsByGroup({
    teamId: team.id,
    collectionId,
    groupKey,
    status,
    sumKey,
    sumKind,
  });
  return c.json({ count: groups.length, data: groups }, 200);
});

collectionRecordRoutes.openapi(mapRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { collectionId, fieldKey, minLng, minLat, maxLng, maxLat } =
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
    collectionId,
    fieldKey,
    bbox,
  });
  return c.json(result, 200);
});

collectionRecordRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const record = await getCollectionRecord({
    id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  return c.json(record, 200);
});

collectionRecordRoutes.openapi(historyRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const { cursor, limit } = c.req.valid("query");
  // The journal service reads by record id alone (operators and the graph
  // fold use it across teams), so the reading team is checked here.
  await assertCanReadRecord({
    recordId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const history = await getRecordHistory({
    recordId: id,
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
  });
  return c.json(history, 200);
});

collectionRecordRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  // The collection comes from the body: it must be one this team may write
  // records into (its own, an org-level one, or one granted with `write`).
  await assertCanWriteType({
    collectionId: body.collectionId,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  await assertRecordSharingAllowed(c.get("principal"), team.id, body.sharing);
  const created = await createCollectionRecord({
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    collectionId: body.collectionId,
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

collectionRecordRoutes.openapi(updateRouteDef, async (c) => {
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
  await assertRecordSharingAllowed(c.get("principal"), team.id, sharing);
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

collectionRecordRoutes.openapi(statusRoute, async (c) => {
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

collectionRecordRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  await assertCanWriteRecord({
    recordId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const result = await deleteCollectionRecord({ id });
  return c.json(result, 200);
});

collectionRecordRoutes.openapi(bulkWriteRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  // The acting user, as on every other write here. A bulk call is one request
  // that writes many rows, not a different kind of author.
  const actor = { actorType: "user" as const, actorUserId: user.id };

  if (body.op === "create") {
    await assertCanWriteType({
      collectionId: body.collectionId,
      teamId: team.id,
      organizationId: team.organizationId,
    });
    const result = await bulkCreateCollectionRecords({
      organizationId: team.organizationId,
      teamId: team.id,
      userId: user.id,
      collectionId: body.collectionId,
      rows: body.rows.map((data) => ({ data })),
      actor,
    });
    return c.json(
      {
        okCount: result.ids.filter((id) => id !== null).length,
        ids: result.ids,
        errors: result.errors,
      },
      200,
    );
  }

  // `collectionId` is in the body, so it is a promise the caller made about
  // every id it sent — and one the write services cannot check, since they
  // scope by team. An id from another collection is refused, not written.
  const ids = body.op === "update" ? body.updates.map((u) => u.id) : body.ids;
  const owned = await idsInCollection({
    teamId: team.id,
    collectionId: body.collectionId,
    ids,
  });
  const strays = ids
    .filter((id) => !owned.has(id))
    .map((id) => ({ id, error: "Record not found in this collection." }));

  if (body.op === "update") {
    const result = await bulkUpdateCollectionRecords({
      teamId: team.id,
      updates: body.updates.filter((u) => owned.has(u.id)),
      merge: body.merge,
      actor,
    });
    return c.json(
      {
        okCount: result.updatedIds.length,
        updatedIds: result.updatedIds,
        errors: [...strays, ...result.errors],
      },
      200,
    );
  }

  const result = await bulkDeleteCollectionRecords({
    teamId: team.id,
    ids: ids.filter((id) => owned.has(id)),
    actor,
  });
  return c.json(
    {
      okCount: result.deletedIds.length,
      deletedIds: result.deletedIds,
      errors: [...strays, ...result.errors],
    },
    200,
  );
});

collectionRecordRoutes.openapi(beginBulkOperationRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const handle = await beginApiLoad({
    ...c.req.valid("json"),
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
  });
  return c.json(serializeApiLoad(handle.operation, handle.doneChunks), 200);
});

collectionRecordRoutes.openapi(bulkOperationChunkRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const { chunkIndex, rows } = c.req.valid("json");
  const operation = await findTeamBulkOperation(id, team.id);
  const outcome = await uploadApiChunk({ operation, chunkIndex, rows });
  return c.json(
    {
      applied: outcome.applied,
      okCount: outcome.succeeded,
      ids: outcome.ids ?? [],
      errors: outcome.errors,
    },
    200,
  );
});

collectionRecordRoutes.openapi(commitBulkOperationRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const finished = await commitApiLoad(
    await findTeamBulkOperation(id, team.id),
  );
  // The ledger is dropped on success, so there is nothing left to skip.
  return c.json(serializeApiLoad(finished, []), 200);
});

collectionRecordRoutes.openapi(getBulkOperationRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const operation = await findTeamBulkOperation(id, team.id);
  return c.json(
    serializeApiLoad(operation, await listDoneChunkIndexes(operation.id)),
    200,
  );
});

export { collectionRecordRoutes };
