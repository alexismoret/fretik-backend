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
  createObjectTypeRequestSchema,
  createObjectTypeWithFieldsRequestSchema,
  objectTypeResponseSchema,
  updateObjectTypeRequestSchema,
} from "@fretik/shared/schemas/ontology";
import { assertCanWriteType } from "@fretik/shared/services/object-sharing/write-access";
import { createObjectType } from "@fretik/shared/services/object-types/create";
import { createObjectTypeWithFields } from "@fretik/shared/services/object-types/create-with-fields";
import { deleteObjectType } from "@fretik/shared/services/object-types/delete";
import {
  getObjectType,
  listObjectTypes,
} from "@fretik/shared/services/object-types/retrieve";
import { updateObjectType } from "@fretik/shared/services/object-types/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Object-types API — the runtime catalog of the dynamic data workspace. Types
 * are created at team scope; the seeded system types (Document, Company, …) are
 * org-scoped and surfaced read-only alongside the team's own.
 */
const objectTypeRoutes = new OpenAPIHono<HonoLoggedAppType>();
objectTypeRoutes.use("*", authMiddleware);

const objectTypeWithFieldsResponseSchema = objectTypeResponseSchema.extend({
  fieldDefinitions: z.array(fieldDefinitionResponseSchema),
});

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List object types",
  description:
    "Lists the active team's object types — the seeded system types plus the team's own.",
  tags: ["ObjectTypes"],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(objectTypeResponseSchema) },
      },
      description: "Object types retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get an object type with its fields",
  tags: ["ObjectTypes"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: objectTypeWithFieldsResponseSchema },
      },
      description: "Object type retrieved",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create an object type",
  tags: ["ObjectTypes"],
  request: {
    body: {
      content: {
        "application/json": { schema: createObjectTypeRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: objectTypeResponseSchema },
      },
      description: "Object type created",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createWithFieldsRouteDef = createRoute({
  method: "post",
  path: "/with-fields",
  summary: "Create an object type with its fields atomically",
  description:
    "Creates a team object type and its initial fields in one transaction — the composer's create. A half-built type can never persist.",
  tags: ["ObjectTypes"],
  request: {
    body: {
      content: {
        "application/json": { schema: createObjectTypeWithFieldsRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: objectTypeWithFieldsResponseSchema },
      },
      description: "Object type created with its fields",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update an object type",
  tags: ["ObjectTypes"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: updateObjectTypeRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: objectTypeResponseSchema },
      },
      description: "Object type updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete an object type",
  description:
    "Deletes a team object type and its records. The Document type is delete-protected.",
  tags: ["ObjectTypes"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ id: z.uuid() }) },
      },
      description: "Object type deleted",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

objectTypeRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const types = await listObjectTypes({
    organizationId: team.organizationId,
    teamId: team.id,
    includeDisabled: true,
  });
  return c.json(types, 200);
});

objectTypeRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const type = await getObjectType({ id, teamId: team.id });
  return c.json(type, 200);
});

objectTypeRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const body = c.req.valid("json");
  const created = await createObjectType({
    organizationId: team.organizationId,
    teamId: team.id,
    key: body.key,
    label: body.label,
    labelPlural: body.labelPlural ?? null,
    description: body.description ?? null,
    icon: body.icon ?? null,
    color: body.color ?? null,
  });
  return c.json(created, 201);
});

objectTypeRoutes.openapi(createWithFieldsRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const body = c.req.valid("json");
  const created = await createObjectTypeWithFields({
    organizationId: team.organizationId,
    teamId: team.id,
    key: body.key,
    label: body.label,
    labelPlural: body.labelPlural ?? null,
    description: body.description ?? null,
    icon: body.icon ?? null,
    color: body.color ?? null,
    fields: body.fields,
  });
  return c.json(created, 201);
});

objectTypeRoutes.openapi(updateRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  const patch = c.req.valid("json");
  await assertCanWriteType({
    objectTypeId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const updated = await updateObjectType({ id, patch });
  return c.json(updated, 200);
});

objectTypeRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { id } = c.req.valid("param");
  await assertCanWriteType({
    objectTypeId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const result = await deleteObjectType({ id });
  return c.json(result, 200);
});

export { objectTypeRoutes };
