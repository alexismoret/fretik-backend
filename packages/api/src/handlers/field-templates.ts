import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import { teamRequired } from "@fretik/shared/lib/errors";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  applyTemplateRequestSchema,
  documentFieldTemplateListEntrySchema,
} from "@fretik/shared/schemas/field-definitions";
import { applyDocumentFieldTemplate } from "@fretik/shared/services/field-definitions/apply-template";
import { listDocumentFieldTemplates } from "@fretik/shared/services/field-definitions/list-templates";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Field templates API — code-defined presets (default + optional
 * industry-specific templates: transport, legal, accounting, …) that
 * the user can apply via the settings UI. Templates are localised
 * through the dedicated template i18n instance
 * (`@fretik/shared/templates/document-fields/i18n.ts`) and resolved to
 * the current team's `teamSettings.lang` at apply time.
 */

const fieldTemplateRoutes = new OpenAPIHono<HonoLoggedAppType>();
fieldTemplateRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List available document field templates",
  tags: ["FieldTemplates"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(documentFieldTemplateListEntrySchema),
        },
      },
      description: "Templates listed",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const applyRoute = createRoute({
  method: "post",
  path: "/apply",
  summary: "Apply a template to the current team or organization",
  tags: ["FieldTemplates"],
  request: {
    body: {
      content: {
        "application/json": { schema: applyTemplateRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            inserted: z.number(),
            skipped: z.number(),
            dropped: z.number(),
          }),
        },
      },
      description: "Template applied",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

/**
 * Cast helper: the template service returns `type: string` (one of the
 * runtime field types), the OpenAPI schema expects the typed enum union.
 * They are identical sets — narrow without re-validating.
 */
const TEMPLATE_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multi_select",
  "url",
  "email",
] as const;
type TemplateFieldType = (typeof TEMPLATE_FIELD_TYPES)[number];

fieldTemplateRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const raw = await listDocumentFieldTemplates({ teamId: team.id });
  const templates = raw.map((t) => ({
    ...t,
    fields: t.fields.map((f) => ({
      ...f,
      type: f.type as TemplateFieldType,
    })),
  }));
  return c.json(templates, 200);
});

fieldTemplateRoutes.openapi(applyRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { templateKey, scope, mode } = c.req.valid("json");

  if (scope === "organization") {
    await assertOrgAdmin({
      userId: user.id,
      organizationId: team.organizationId,
      message: "Applying an org-scope template requires admin or owner",
    });
  }

  const result = await applyDocumentFieldTemplate({
    organizationId: team.organizationId,
    teamId: scope === "organization" ? null : team.id,
    templateKey,
    mode,
  });
  return c.json(result, 200);
});

export { fieldTemplateRoutes };
