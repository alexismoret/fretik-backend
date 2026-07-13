import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import {
  badRequest,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  BUILTIN_TOOL_POLICY_CATALOG,
  teamToolPoliciesPatchSchema,
  toolPoliciesCatalogResponseSchema,
  type ToolPolicyLevel,
} from "@fretik/shared/schemas/tool-policies";
import { getTeamToolPolicies } from "@fretik/shared/services/tool-policies/get-for-team";
import { upsertTeamToolPolicies } from "@fretik/shared/services/tool-policies/upsert";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/tool-policies` — the team's builtin-tool permission map. GET returns the
 * catalog (each policy-managed tool + its default, selectable levels, and the
 * team's override) so the settings page can render one row per tool. PATCH
 * (admin) applies a sparse override patch. External-app ACTION policies live on
 * the connection (see `/external-apps/connections/{id}`), not here.
 */
const toolPoliciesRoutes = new OpenAPIHono<HonoLoggedAppType>();
toolPoliciesRoutes.use("*", authMiddleware);

const getRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List the team's builtin-tool permission policies",
  tags: ["ToolPolicies"],
  responses: {
    200: {
      content: {
        "application/json": { schema: toolPoliciesCatalogResponseSchema },
      },
      description: "Tool policy catalog + team overrides",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/",
  summary: "Set the team's builtin-tool permission overrides (admin only)",
  description:
    "Sparse patch keyed by tool name: a level sets the override, `null` resets to the code default. Names are validated against the catalog and levels against each tool's selectable set.",
  tags: ["ToolPolicies"],
  request: {
    body: {
      content: {
        "application/json": { schema: teamToolPoliciesPatchSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: toolPoliciesCatalogResponseSchema },
      },
      description: "Updated policies",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const buildCatalog = (overrides: Record<string, ToolPolicyLevel>) => ({
  tools: Object.values(BUILTIN_TOOL_POLICY_CATALOG).map((d) => {
    const override = overrides[d.name];
    return {
      name: d.name,
      kind: d.kind,
      defaultLevel: d.defaultLevel,
      selectableLevels: [...d.selectableLevels],
      labelKey: d.labelKey,
      override: override ?? null,
      effectiveLevel: override ?? d.defaultLevel,
    };
  }),
});

toolPoliciesRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  const overrides = await getTeamToolPolicies(team.id);
  return c.json(buildCatalog(overrides), 200);
});

toolPoliciesRoutes.openapi(patchRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
  });

  const patch = c.req.valid("json");
  // Validate names against the catalog and levels against each tool's
  // selectable set — reject anything outside (e.g. `approval` on a read tool,
  // or a tool not in the catalog such as python/bash).
  for (const [name, level] of Object.entries(patch)) {
    const descriptor = BUILTIN_TOOL_POLICY_CATALOG[name];
    if (descriptor === undefined) {
      return throwHttpError(400, badRequest(`Unknown tool "${name}"`));
    }
    if (level !== null && !descriptor.selectableLevels.includes(level)) {
      return throwHttpError(
        400,
        badRequest(`"${level}" is not selectable for "${name}"`),
      );
    }
  }

  const merged = await upsertTeamToolPolicies({ teamId: team.id, patch });
  return c.json(buildCatalog(merged), 200);
});

export { toolPoliciesRoutes };
