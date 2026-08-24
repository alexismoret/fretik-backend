import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import { teamRequired } from "@fretik/shared/lib/errors";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  checkFormulaRequestSchema,
  checkFormulaResponseSchema,
  createFieldDefinitionRequestSchema,
  fieldDefinitionResponseSchema,
  formulaFunctionsResponseSchema,
  reorderFieldDefinitionsRequestSchema,
  updateFieldDefinitionRequestSchema,
} from "@fretik/shared/schemas/field-definitions";
import {
  checkFormula,
  formulaFunctionCatalog,
} from "@fretik/shared/services/field-definitions/check-formula";
import { createFieldDefinition } from "@fretik/shared/services/field-definitions/create";
import { deleteFieldDefinition } from "@fretik/shared/services/field-definitions/delete";
import { getFieldDefinitionsForOrganization } from "@fretik/shared/services/field-definitions/get-for-org";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { reorderFieldDefinitions } from "@fretik/shared/services/field-definitions/reorder";
import { updateFieldDefinition } from "@fretik/shared/services/field-definitions/update";
import {
  assertCanWriteField,
  assertCanWriteType,
} from "@fretik/shared/services/object-sharing/write-access";
import { DOCUMENT_TYPE_KEY } from "@fretik/shared/services/object-types/constants";
import { resolveOrgObjectTypeId } from "@fretik/shared/services/object-types/resolve";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Field-definitions API.
 *
 * Two scope lookups exist — team (used at runtime by every consumer:
 * upload, retrieve, vectorize, filters, panel) and organization (only
 * used as a template duplicated into new teams).
 *
 * Org-scope writes (create/update/delete/reorder under scope=organization)
 * require admin/owner role; team-scope writes are open to any member of
 * the active team.
 */

const fieldDefinitionRoutes = new OpenAPIHono<HonoLoggedAppType>();
fieldDefinitionRoutes.use("*", authMiddleware);

const scopeQuerySchema = z.object({
  scope: z.enum(["team", "organization"]).default("team"),
});

// ============================================================================
// Routes
// ============================================================================

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List field definitions",
  description:
    "Lists field definitions for the active team (default) or for the organization (admin only).",
  tags: ["FieldDefinitions"],
  request: { query: scopeQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(fieldDefinitionResponseSchema),
        },
      },
      description: "Field definitions retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create a field definition",
  tags: ["FieldDefinitions"],
  request: {
    body: {
      content: {
        "application/json": { schema: createFieldDefinitionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: fieldDefinitionResponseSchema },
      },
      description: "Field definition created",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a field definition",
  tags: ["FieldDefinitions"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: updateFieldDefinitionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: fieldDefinitionResponseSchema },
      },
      description: "Field definition updated",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a field definition",
  tags: ["FieldDefinitions"],
  request: {
    params: paramsIdSchema,
    query: z.object({
      cascade: z.coerce.boolean().optional().default(false),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ id: z.uuid(), deletedValues: z.number() }),
        },
      },
      description: "Field definition deleted",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const reorderRoute = createRoute({
  method: "post",
  path: "/reorder",
  summary: "Reorder field definitions",
  tags: ["FieldDefinitions"],
  request: {
    body: {
      content: {
        "application/json": { schema: reorderFieldDefinitionsRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Reordered",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const checkFormulaRoute = createRoute({
  method: "post",
  path: "/check-formula",
  summary: "Dry-run a formula expression",
  description:
    "Compiles a formula against an object type's fields WITHOUT saving, and returns the type it evaluates to or the reason it cannot compile. Powers the live feedback in the formula editor; an invalid expression is a 200 with `ok: false`, not an error — it is the normal state while one is being typed.",
  tags: ["FieldDefinitions"],
  request: {
    body: {
      content: {
        "application/json": { schema: checkFormulaRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: checkFormulaResponseSchema },
      },
      description: "Formula checked",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const formulaFunctionsRoute = createRoute({
  method: "get",
  path: "/formula-functions",
  summary: "List the formula language's functions",
  description:
    "Every function a formula may call, with its parameters in order. Drives the visual formula builder, which renders one labelled slot per parameter — the list is served rather than mirrored client-side so the form always matches the function it builds.",
  tags: ["FieldDefinitions"],
  responses: {
    200: {
      content: {
        "application/json": { schema: formulaFunctionsResponseSchema },
      },
      description: "Function catalog",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ============================================================================
// Handlers
// ============================================================================

fieldDefinitionRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");

  const { scope } = c.req.valid("query");
  if (scope === "organization") {
    await assertOrgAdmin({
      userId: user.id,
      organizationId: team.organizationId,
    });
    const defs = await getFieldDefinitionsForOrganization({
      organizationId: team.organizationId,
      includeDisabled: true,
    });
    return c.json(defs, 200);
  }
  const defs = await getFieldDefinitionsForTeam({
    teamId: team.id,
    includeDisabled: true,
  });
  return c.json(defs, 200);
});

fieldDefinitionRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");

  const body = c.req.valid("json");
  if (body.scope === "organization") {
    await assertOrgAdmin({
      userId: user.id,
      organizationId: team.organizationId,
    });
  }

  const objectTypeId =
    body.objectTypeId ??
    (await resolveOrgObjectTypeId({
      organizationId: team.organizationId,
      key: body.objectTypeKey ?? DOCUMENT_TYPE_KEY,
    }));

  await assertCanWriteType({
    objectTypeId,
    teamId: team.id,
    organizationId: team.organizationId,
  });

  const created = await createFieldDefinition({
    organizationId: team.organizationId,
    teamId: body.scope === "organization" ? null : team.id,
    objectTypeId,
    key: body.key,
    label: body.label,
    description: body.description ?? null,
    type: body.type,
    config: body.config,
    isTitle: body.isTitle,
    aiExtractionEnabled: body.aiExtractionEnabled,
    vectorizeInclude: body.vectorizeInclude,
    displayInPanel: body.displayInPanel,
    enabled: body.enabled,
    displayOrder: body.displayOrder,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(created, 201);
});

fieldDefinitionRoutes.openapi(updateRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  // Org-vs-team scope is enforced by the existing row's teamId — the
  // service rejects scope-crossing updates implicitly.

  const { id } = c.req.valid("param");
  await assertCanWriteField({
    fieldDefinitionId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const body = c.req.valid("json");
  const { cascade, ...patch } = body;
  const updated = await updateFieldDefinition({
    id,
    cascade,
    patch,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(updated, 200);
});

fieldDefinitionRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");

  const { id } = c.req.valid("param");
  await assertCanWriteField({
    fieldDefinitionId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });
  const { cascade } = c.req.valid("query");
  const result = await deleteFieldDefinition({
    id,
    cascade,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(result, 200);
});

fieldDefinitionRoutes.openapi(reorderRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");

  const { scope, ids } = c.req.valid("json");
  if (scope === "organization") {
    await assertOrgAdmin({
      userId: user.id,
      organizationId: team.organizationId,
    });
  }

  await reorderFieldDefinitions({
    organizationId: team.organizationId,
    teamId: scope === "organization" ? null : team.id,
    ids,
  });
  return c.json({ ok: true }, 200);
});

fieldDefinitionRoutes.openapi(checkFormulaRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const { objectTypeId, expression, fieldId } = c.req.valid("json");
  // Reading a type's field NAMES is what the check exposes, so it is gated on
  // being able to write the type — the same door the save goes through.
  await assertCanWriteType({
    objectTypeId,
    teamId: team.id,
    organizationId: team.organizationId,
  });

  const result = await checkFormula({
    objectTypeId,
    teamId: team.id,
    excludeFieldId: fieldId,
    expression,
  });
  return c.json(result, 200);
});

fieldDefinitionRoutes.openapi(formulaFunctionsRoute, (c) =>
  c.json({ functions: formulaFunctionCatalog() }, 200),
);

export { fieldDefinitionRoutes };
