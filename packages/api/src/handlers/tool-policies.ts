import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
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
  parseToolPolicyKey,
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
 * (`team.settings.manage`: team leads and admins) applies a sparse override
 * patch. External-app ACTION policies live on the connection (see
 * `/external-apps/connections/{id}`), not here.
 */
const toolPoliciesRoutes = new OpenAPIHono<HonoLoggedAppType>();
toolPoliciesRoutes.use("*", authMiddleware);

const getRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.session(
    "Any member of the active team reads what its tools may do.",
  ),
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
  middleware: access.capability("team.settings.manage"),
  summary: "Set the team's builtin-tool permission overrides (team leads)",
  description:
    "Sparse patch keyed by tool name, or by `tool.action` for a single action of a multi-action tool: a level sets the override, `null` resets to the default. Names are validated against the catalog and levels against the relevant selectable set (`blocked` is tool-level only).",
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
    // An action follows the tool's override when it has no override of its
    // own — except a tool-wide `blocked`, which the per-action select cannot
    // represent (actions stop at `approval`) and which hides the tool anyway.
    const toolBaseline =
      override === undefined || override === "blocked" ? undefined : override;
    const actions =
      d.actions === undefined
        ? undefined
        : Object.entries(d.actions).map(([name, a]) => {
            const actionOverride = overrides[`${d.name}.${name}`];
            const baselineLevel = toolBaseline ?? a.defaultLevel;
            return {
              name,
              defaultLevel: a.defaultLevel,
              selectableLevels: [...a.selectableLevels],
              labelKey: a.labelKey,
              override: actionOverride ?? null,
              baselineLevel,
              effectiveLevel: actionOverride ?? baselineLevel,
            };
          });
    return {
      name: d.name,
      group: d.group,
      kind: d.kind,
      defaultLevel: d.defaultLevel,
      selectableLevels: [...d.selectableLevels],
      labelKey: d.labelKey,
      override: override ?? null,
      effectiveLevel: override ?? d.defaultLevel,
      ...(actions === undefined ? {} : { actions }),
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
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  const patch = c.req.valid("json");
  // Validate names against the catalog and levels against the relevant
  // selectable set — reject anything outside (e.g. `approval` on a read tool,
  // `blocked` on a single action, or a tool not in the catalog such as
  // python/bash).
  for (const [key, level] of Object.entries(patch)) {
    const { toolName, action } = parseToolPolicyKey(key);
    const descriptor = BUILTIN_TOOL_POLICY_CATALOG[toolName];
    if (descriptor === undefined) {
      return throwHttpError(400, badRequest(`Unknown tool "${toolName}"`));
    }
    const actionDescriptor =
      action === undefined ? undefined : descriptor.actions?.[action];
    if (action !== undefined && actionDescriptor === undefined) {
      return throwHttpError(
        400,
        badRequest(`Unknown action "${action}" for "${toolName}"`),
      );
    }
    const selectable =
      actionDescriptor?.selectableLevels ?? descriptor.selectableLevels;
    if (level !== null && !selectable.includes(level)) {
      return throwHttpError(
        400,
        badRequest(`"${level}" is not selectable for "${key}"`),
      );
    }
  }

  const merged = await upsertTeamToolPolicies({ teamId: team.id, patch });
  return c.json(buildCatalog(merged), 200);
});

export { toolPoliciesRoutes };
