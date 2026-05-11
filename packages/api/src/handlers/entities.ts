import db from "@fretik/shared/db";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired, throwHttpError } from "@fretik/shared/lib/errors";
import {
  paramsIdSchema,
  paramsListSchema,
} from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseCreatedSchemaBuilder,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
  responseSuccessDeletedSchema,
  responseSuccessSchemaBuilder,
} from "@fretik/shared/schemas/common/responses";
import {
  CreateEntitySchema,
  DocumentEntityResponseSchema,
  EntityCountsResponseSchema,
  EntityListResponseSchema,
  EntityResponseSchema,
  entityStatusSchema,
  entityTypeSchema,
  MergeEntitySchema,
  UpdateEntitySchema,
} from "@fretik/shared/schemas/entities";
import {
  triggerDocumentVectorRefresh,
  triggerEntityDocumentsVectorRefresh,
} from "@fretik/shared/services/documents/vector-refresh";
import { createEntity } from "@fretik/shared/services/entities/create";
import { deleteEntity } from "@fretik/shared/services/entities/delete";
import {
  getDocumentEntities,
  getEntity,
  getEntityCounts,
  listEntities,
} from "@fretik/shared/services/entities/retrieve";
import {
  mergeEntity,
  updateEntity,
} from "@fretik/shared/services/entities/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

// ==================== //
// ROUTER SETUP         //
// ==================== //

const entityRoutes = new OpenAPIHono<HonoLoggedAppType>();
entityRoutes.use("*", authMiddleware);

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const listEntitiesRoute = createRoute({
  method: "get",
  path: "",
  summary: "List entities",
  description: "List entities with pagination, filtering by status and type",
  tags: ["Entities"],
  request: {
    query: paramsListSchema.extend({
      status: entityStatusSchema.optional(),
      type: entityTypeSchema.optional(),
    }),
  },
  responses: {
    ...responseSuccessSchemaBuilder(EntityListResponseSchema),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getEntityCountsRoute = createRoute({
  method: "get",
  path: "/counts",
  summary: "Get entity counts by status",
  description: "Returns counts for confirmed, suggested, and rejected entities",
  tags: ["Entities"],
  responses: {
    ...responseSuccessSchemaBuilder(EntityCountsResponseSchema),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getEntityRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get entity details",
  description: "Get a single entity by ID with document count",
  tags: ["Entities"],
  request: {
    params: paramsIdSchema,
  },
  responses: {
    ...responseSuccessSchemaBuilder(EntityResponseSchema),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createEntityRoute = createRoute({
  method: "post",
  path: "",
  summary: "Create an entity",
  description: "Create a new confirmed entity",
  tags: ["Entities"],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateEntitySchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseCreatedSchemaBuilder(EntityResponseSchema),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateEntityRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update an entity",
  description:
    "Update entity properties. Set status to 'confirmed' to confirm a suggestion.",
  tags: ["Entities"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: UpdateEntitySchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(EntityResponseSchema),
    ...responseNotFoundSchema,
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteEntityRoute = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete an entity",
  description: "Delete an entity and all its document links",
  tags: ["Entities"],
  request: {
    params: paramsIdSchema,
  },
  responses: {
    ...responseSuccessDeletedSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const mergeEntityRoute = createRoute({
  method: "post",
  path: "/{id}/merge",
  summary: "Merge entity into another",
  description:
    "Merge source entity into target. Moves all links and adds aliases.",
  tags: ["Entities"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: MergeEntitySchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(EntityResponseSchema),
    ...responseNotFoundSchema,
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getDocumentEntitiesRoute = createRoute({
  method: "get",
  path: "/document/{id}",
  summary: "Get document entities",
  description: "Get all entity links for a specific document",
  tags: ["Entities"],
  request: {
    params: paramsIdSchema,
  },
  responses: {
    ...responseSuccessSchemaBuilder(z.array(DocumentEntityResponseSchema)),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// ROUTE HANDLERS       //
// ==================== //

entityRoutes.openapi(listEntitiesRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { limit, page, search, status, type } = c.req.valid("query");

  const result = await listEntities({
    teamId: team.id,
    status,
    type,
    search,
    limit,
    offset: page * limit,
  });

  return c.json(result, 200);
});

entityRoutes.openapi(getEntityCountsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const counts = await getEntityCounts({ teamId: team.id });
  return c.json(counts, 200);
});

entityRoutes.openapi(getEntityRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const entity = await getEntity({ id, teamId: team.id });

  return c.json(entity, 200);
});

entityRoutes.openapi(createEntityRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const input = c.req.valid("json");
  const created = await createEntity({ teamId: team.id, input });
  const entity = await getEntity({ id: created.id, teamId: team.id });

  return c.json(entity, 201);
});

entityRoutes.openapi(updateEntityRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const input = c.req.valid("json");
  await updateEntity({ id, teamId: team.id, input });
  const entity = await getEntity({ id, teamId: team.id });

  // Refresh vectors for all documents linked to this entity (fire-and-forget)
  triggerEntityDocumentsVectorRefresh(id, team.id, team.organizationId).catch(
    () => {},
  );

  return c.json(entity, 200);
});

entityRoutes.openapi(deleteEntityRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");

  // Fetch linked documents before deletion (cascade will remove the links)
  const linkedDocs = await db.query.documentEntities.findMany({
    where: { entityId: id },
    columns: { documentId: true },
  });

  const res = await deleteEntity({ id, teamId: team.id });

  // Refresh vectors for all previously linked documents (fire-and-forget)
  const uniqueDocIds = [...new Set(linkedDocs.map((d) => d.documentId))];
  for (const docId of uniqueDocIds) {
    triggerDocumentVectorRefresh(docId, team.id, team.organizationId).catch(
      () => {},
    );
  }

  return c.json({ rowCount: res.rowCount }, 200);
});

entityRoutes.openapi(mergeEntityRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const input = c.req.valid("json");
  await mergeEntity({ sourceId: id, teamId: team.id, input });
  const entity = await getEntity({ id: input.targetEntityId, teamId: team.id });

  // Refresh vectors for all documents linked to the merged entity (fire-and-forget)
  triggerEntityDocumentsVectorRefresh(
    input.targetEntityId,
    team.id,
    team.organizationId,
  ).catch(() => {});

  return c.json(entity, 200);
});

entityRoutes.openapi(getDocumentEntitiesRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id: documentId } = c.req.valid("param");
  const links = await getDocumentEntities({ documentId });

  return c.json(links, 200);
});

export { entityRoutes };
