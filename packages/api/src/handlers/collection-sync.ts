import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { MAX_BULK_ITEMS } from "@fretik/shared/lib/db-bulk";
import {
  badRequest,
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import {
  createSyncSourceSchema,
  previewSyncSourceResponseSchema,
  previewSyncSourceSchema,
  SYNC_LIMITS,
  syncRunResponseSchema,
  syncSourceResponseSchema,
  updateSyncSourceSchema,
} from "@fretik/shared/schemas/collection-sync";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseListSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { confirmFullResync } from "@fretik/shared/services/collection-sync/confirm-full-resync";
import { createSyncSource } from "@fretik/shared/services/collection-sync/create-source";
import { deleteSyncSource } from "@fretik/shared/services/collection-sync/delete-source";
import { getSyncSource } from "@fretik/shared/services/collection-sync/get-source";
import { listSyncRuns } from "@fretik/shared/services/collection-sync/list-runs";
import { listSyncSources } from "@fretik/shared/services/collection-sync/list-sources";
import { previewSyncSource } from "@fretik/shared/services/collection-sync/preview";
import { requestSyncRefresh } from "@fretik/shared/services/collection-sync/request-refresh";
import {
  loadSyncSourceContext,
  serializeSyncSource,
} from "@fretik/shared/services/collection-sync/serialize";
import { updateSyncSource } from "@fretik/shared/services/collection-sync/update-source";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Collection sync — the declaration that a collection, or some of its columns,
 * is filled by a connected app.
 *
 * Everything here is a DECLARATION or a request to act on one; no upstream call
 * happens in the request except `POST /preview`, which is the one place a
 * person is waiting to see what they are mapping. `POST /{id}/run` hands the
 * work to the queue and answers with the queued job, so the UI polls the run
 * list instead of holding a connection open for something that walks 200 pages
 * of a third-party API.
 *
 * WHO MAY DECLARE ONE: any member of the team, which is deliberately the same
 * rule as creating a CONNECTION (`POST /external-apps/connections` has no admin
 * gate — only per-action policies and re-scoping do). A source spends the quota
 * of a connection the team already agreed to share, so gating the source while
 * leaving the connection open would protect nothing and confuse everyone. Team
 * scope itself is enforced on every route from the session's team, as in
 * `collection-records.ts`.
 */

const collectionSyncRoutes = new OpenAPIHono<HonoLoggedAppType>();
collectionSyncRoutes.use("*", authMiddleware);

const listQuerySchema = z.object({
  /** Omit to list every source of the team — the settings-wide view. */
  collectionId: z.uuid().optional(),
});

const runsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SYNC_LIMITS.runHistoryLimit)
    .default(SYNC_LIMITS.runHistoryLimit),
});

/**
 * A manual refresh may name the rows to do FIRST. The frontend knows which ids
 * are on screen and nothing else does, which is what makes "the page I am
 * looking at fills in first" possible on a `lookup` source over 20 000 records.
 * Send `{}` for the whole source.
 */
const runRequestSchema = z.object({
  // `MAX_BULK_ITEMS`, not the per-run batch size: these ids are MARKED
  // `pending` and drained over as many runs as it takes, so the bound that
  // belongs here is the one on a request body, exactly as `request-refresh.ts`
  // already clamps it. Refusing 300 ids because a run only refreshes 200 was
  // refusing a request the engine could serve.
  recordIds: z.array(z.uuid()).max(MAX_BULK_ITEMS).optional(),
});

const listSourcesRoute = createRoute({
  method: "get",
  path: "/sources",
  summary: "List the sync sources of a collection (or of the whole team)",
  tags: ["CollectionSync"],
  request: { query: listQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(syncSourceResponseSchema),
        },
      },
      description: "Sync sources",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getSourceRoute = createRoute({
  method: "get",
  path: "/sources/{id}",
  summary: "Get one sync source",
  tags: ["CollectionSync"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: syncSourceResponseSchema } },
      description: "Sync source",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const createSourceRoute = createRoute({
  method: "post",
  path: "/sources",
  summary: "Declare that an app fills this collection, or some of its columns",
  description:
    '`kind: table` makes the source own the collection: one upstream row becomes one record, keyed by `externalIdPath`, and the mapped columns are created read-only. `kind: lookup` fills SOME columns of an existing collection, resolving its arguments per record from `{"$field": "<key>"}` bindings. The columns land as ORDINARY typed columns, so formulas, filters, sorts, indexes and the SQL tool work on them unchanged — what the source adds is provenance and a schedule. Creating one queues a first run.',
  tags: ["CollectionSync"],
  request: {
    body: {
      content: { "application/json": { schema: createSyncSourceSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: syncSourceResponseSchema } },
      description: "Sync source created",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const updateSourceRoute = createRoute({
  method: "patch",
  path: "/sources/{id}",
  summary: "Change a source's arguments, mapping, cadence or state",
  description:
    "Partial update. The `kind`, the collection and the external-id path are NOT editable: they decide what a record IS, so changing one would re-key every row already stored — rebuilding is a delete and a create, which is honest about what happens to the data. Dropping a column from `fields` does not delete it: it becomes an ordinary local field, with its values, editable from then on.",
  tags: ["CollectionSync"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: updateSyncSourceSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: syncSourceResponseSchema } },
      description: "Sync source updated",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteSourceRoute = createRoute({
  method: "delete",
  path: "/sources/{id}",
  summary: "Stop syncing — the columns and their data are KEPT",
  description:
    "Deleting a source is not deleting data. Every column it filled stays, with the values of the last run, and becomes an ordinary editable field of the collection (`field_definitions.sync_source_id` is cleared, never the column). Records a `table` source created stay too. What goes away is the mapping, the schedule and the read-only rule — which is exactly what someone means by 'detach this from the app'.",
  tags: ["CollectionSync"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ id: z.uuid(), deleted: z.literal(true) }),
        },
      },
      description: "Sync source deleted, its columns kept",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

/**
 * What a refresh request answers with.
 *
 * NOT the run row: the run is opened by the worker that picks the job up, so
 * this route has none to return without inventing one. `jobId` is the queue's
 * own id, and it is stable per source — a second press of Refresh while the
 * first is still in flight JOINS that job and comes back with the same id,
 * which is exactly what tells the UI it did not start a second pass over the
 * third party. The run itself appears in `GET /sources/{id}/runs`.
 */
const runAcceptedSchema = z.object({
  sourceId: z.uuid(),
  enqueued: z.literal(true),
  jobId: z.string(),
});

const runSourceRoute = createRoute({
  method: "post",
  path: "/sources/{id}/run",
  summary: "Refresh now",
  description:
    "Queues a run and answers with the queued job, not with data: the work happens in the background and the records change underneath. Poll `GET /sources/{id}/runs` for what it did. A refresh already in flight is JOINED rather than duplicated — pressing Refresh twice returns the same `jobId` and calls the third party once. A source that is disabled, or whose connection is gone, is refused with the reason rather than queued for a failure we already know about.",
  tags: ["CollectionSync"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: runRequestSchema } },
      required: true,
    },
  },
  responses: {
    202: {
      content: { "application/json": { schema: runAcceptedSchema } },
      description: "Refresh queued (or joined to the one in flight)",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const confirmFullResyncRoute = createRoute({
  method: "post",
  path: "/sources/{id}/confirm-full-resync",
  summary: "Apply the orphan policy that a run refused to apply",
  description:
    "A run whose answer would have orphaned most of the collection applies NOTHING — it ends `partial` with `stopReason: orphan_floor` and asks, because an upstream filter narrowing and a mass deletion produce the same short answer and only a person can tell them apart. This confirms it: the next run walks every row and applies the orphan policy whatever the difference comes to. Refused when no run has asked, so a confirmation is always an answer to numbers somebody has seen.",
  tags: ["CollectionSync"],
  request: { params: paramsIdSchema },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({ sourceId: z.uuid(), enqueued: z.boolean() }),
        },
      },
      description: "Confirmed; a full resync is queued",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const listRunsRoute = createRoute({
  method: "get",
  path: "/sources/{id}/runs",
  summary: "A source's recent runs",
  description:
    "Newest first. `upstreamCalls` is the number the team can act on — it is what a cadence costs someone else's rate limit — and `truncated` says a bound was reached (the row cap, the call budget, the run deadline) rather than the upstream having run out of rows.",
  tags: ["CollectionSync"],
  request: { params: paramsIdSchema, query: runsQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(syncRunResponseSchema),
        },
      },
      description: "Runs, newest first",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  summary: "Read a sample from the app and propose a mapping",
  description:
    "Calls the action once, keeps the first rows, and proposes one column per value — its type DECLARED from the manifest where the provider typed its answer, INFERRED from the sample where it did not (MCP servers, generic backends). `suggestedIdPaths` ranks the paths that look like a stable upstream id, which is what a `table` source is keyed on. Writes nothing: this is the only route here that waits on a third party, because it is the only one a person is watching.",
  tags: ["CollectionSync"],
  request: {
    body: {
      content: { "application/json": { schema: previewSyncSourceSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: previewSyncSourceResponseSchema },
      },
      description: "Sample rows and the columns they suggest",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

// ---- Handlers --------------------------------------------------------

collectionSyncRoutes.openapi(listSourcesRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { collectionId } = c.req.valid("query");
  const sources = await listSyncSources({
    teamId: team.id,
    ...(collectionId ? { collectionId } : {}),
  });
  return c.json({ count: sources.length, data: sources }, 200);
});

collectionSyncRoutes.openapi(createSourceRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const source = await createSyncSource({
    ...body,
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
  });
  // Two calls because serializing is batched by design: the context holds the
  // connection and the action summary a list of sources would otherwise fetch
  // once per row. A batch of one pays the same shape.
  const context = await loadSyncSourceContext([source]);
  return c.json(serializeSyncSource(source, context), 201);
});

collectionSyncRoutes.openapi(getSourceRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  // Scoped by team in the same query that fetches it — a source of another
  // team is NOT FOUND here, never forbidden, so the route says nothing about
  // what exists elsewhere.
  const source = await getSyncSource({ id, teamId: team.id });
  if (!source) return throwHttpError(404, notFound("Sync source not found"));
  return c.json(source, 200);
});

collectionSyncRoutes.openapi(updateSourceRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const source = await updateSyncSource({
    id,
    teamId: team.id,
    organizationId: team.organizationId,
    userId: c.get("user").id,
    patch: body,
  });
  const context = await loadSyncSourceContext([source]);
  return c.json(serializeSyncSource(source, context), 200);
});

collectionSyncRoutes.openapi(deleteSourceRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  await deleteSyncSource({
    id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  return c.json({ id, deleted: true as const }, 200);
});

collectionSyncRoutes.openapi(runSourceRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { recordIds } = c.req.valid("json");
  const outcome = await requestSyncRefresh({
    sourceId: id,
    teamId: team.id,
    trigger: "manual",
    userId: user.id,
    ...(recordIds && recordIds.length > 0 ? { recordIds } : {}),
  });
  if (!outcome.enqueued) {
    // The service answers a REASON rather than throwing, because the schedule
    // calls it too and a skipped tick is not an error. On this route a person
    // pressed a button, so each reason becomes the answer they can act on.
    if (outcome.reason === "not_found") {
      return throwHttpError(404, notFound("Sync source not found"));
    }
    return throwHttpError(
      400,
      badRequest(
        outcome.reason === "disabled"
          ? "This sync source is turned off. Enable it first. Its columns keep the values of the last run in the meantime."
          : outcome.reason === "no_connection"
            ? "This sync source has no connection left to read through. Reconnect the app, then point the source at the new connection. The columns and their data are untouched."
            : "The data is already fresher than this request asked for.",
      ),
    );
  }
  return c.json(
    { sourceId: id, enqueued: true as const, jobId: outcome.jobId },
    202,
  );
});

collectionSyncRoutes.openapi(confirmFullResyncRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const outcome = await confirmFullResync({
    sourceId: id,
    teamId: team.id,
    userId: user.id,
  });
  return c.json({ sourceId: id, enqueued: outcome.enqueued }, 202);
});

collectionSyncRoutes.openapi(listRunsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  const runs = await listSyncRuns({
    syncSourceId: id,
    teamId: team.id,
    limit,
  });
  return c.json({ count: runs.length, data: runs }, 200);
});

collectionSyncRoutes.openapi(previewRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const preview = await previewSyncSource({
    ...body,
    teamId: team.id,
    // The read goes through the CALLER's connection when the app is connected
    // personally, exactly as a page dataset resolves one — the preview must
    // show what this person's source would actually see.
    userId: user.id,
  });
  return c.json(preview, 200);
});

export { collectionSyncRoutes };
