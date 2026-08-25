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
import { fieldDefinitionResponseSchema } from "@fretik/shared/schemas/field-definitions";
import {
  collectionOverviewResponseSchema,
  collectionResponseSchema,
  createCollectionRequestSchema,
  createCollectionWithFieldsRequestSchema,
  updateCollectionRequestSchema,
} from "@fretik/shared/schemas/ontology";
import { assertCanWriteType } from "@fretik/shared/services/collection-sharing/write-access";
import { createCollection } from "@fretik/shared/services/collections/create";
import { createCollectionWithFields } from "@fretik/shared/services/collections/create-with-fields";
import { deleteCollection } from "@fretik/shared/services/collections/delete";
import { getCollectionsOverview } from "@fretik/shared/services/collections/overview";
import {
  getCollection,
  listCollections,
} from "@fretik/shared/services/collections/retrieve";
import { updateCollection } from "@fretik/shared/services/collections/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Object-types API — the runtime catalog of the dynamic data workspace. Types
 * are created at team scope; the seeded system types (Document, Company, …) are
 * org-scoped and surfaced read-only alongside the team's own.
 */
const collectionRoutes = new OpenAPIHono<HonoLoggedAppType>();
collectionRoutes.use("*", authMiddleware);

const collectionWithFieldsResponseSchema = collectionResponseSchema.extend({
  fieldDefinitions: z.array(fieldDefinitionResponseSchema),
});

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List collections",
  description:
    "Lists the active team's collections — the seeded system types plus the team's own.",
  tags: ["Collections"],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(collectionResponseSchema) },
      },
      description: "Collections retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  summary: "List collections with record counts",
  description:
    "The team's visible collections, each with its confirmed-record total and its count of AI-suggested records awaiting review — the home dashboard's objects grid in one round-trip.",
  tags: ["Collections"],
  responses: {
    200: {
      content: {
        "application/json": { schema: collectionOverviewResponseSchema },
      },
      description: "Collections overview retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get a collection with its fields",
  tags: ["Collections"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: collectionWithFieldsResponseSchema },
      },
      description: "Collection retrieved",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create a collection",
  tags: ["Collections"],
  request: {
    body: {
      content: {
        "application/json": { schema: createCollectionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: collectionResponseSchema },
      },
      description: "Collection created",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createWithFieldsRouteDef = createRoute({
  method: "post",
  path: "/with-fields",
  summary: "Create a collection with its fields atomically",
  description:
    "Creates a team collection and its initial fields in one transaction — the composer's create. A half-built type can never persist.",
  tags: ["Collections"],
  request: {
    body: {
      content: {
        "application/json": { schema: createCollectionWithFieldsRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: collectionWithFieldsResponseSchema },
      },
      description: "Collection created with its fields",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a collection",
  tags: ["Collections"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: updateCollectionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: collectionResponseSchema },
      },
      description: "Collection updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a collection",
  description:
    "Deletes a team collection and its records. The Document type is delete-protected.",
  tags: ["Collections"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ id: z.uuid() }) },
      },
      description: "Collection deleted",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

collectionRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const types = await listCollections({
    organizationId: team.organizationId,
    teamId: team.id,
    includeDisabled: true,
  });
  return c.json(types, 200);
});

collectionRoutes.openapi(overviewRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const overview = await getCollectionsOverview({
    organizationId: team.organizationId,
    teamId: team.id,
  });
  return c.json(overview, 200);
});

collectionRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const type = await getCollection({ id, teamId: team.id });
  return c.json(type, 200);
});

collectionRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const created = await createCollection({
    organizationId: team.organizationId,
    teamId: team.id,
    key: body.key,
    label: body.label,
    labelPlural: body.labelPlural ?? null,
    description: body.description ?? null,
    icon: body.icon ?? null,
    color: body.color ?? null,
    sharing: body.sharing,
    createdByUserId: user.id,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(created, 201);
});

collectionRoutes.openapi(createWithFieldsRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const created = await createCollectionWithFields({
    organizationId: team.organizationId,
    teamId: team.id,
    key: body.key,
    label: body.label,
    labelPlural: body.labelPlural ?? null,
    description: body.description ?? null,
    icon: body.icon ?? null,
    color: body.color ?? null,
    fields: body.fields,
    sharing: body.sharing,
    createdByUserId: user.id,
  });
  return c.json(created, 201);
});

collectionRoutes.openapi(updateRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { sharing, ...patch } = c.req.valid("json");
  await assertCanWriteType({
    collectionId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const updated = await updateCollection({
    id,
    patch,
    sharing,
    callerTeamId: team.id,
    createdByUserId: user.id,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(updated, 200);
});

collectionRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  await assertCanWriteType({
    collectionId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const result = await deleteCollection({
    id,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(result, 200);
});

export { collectionRoutes };
