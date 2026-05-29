import { listProviderManifests } from "@fretik/shared/external-apps/registry";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  providersListResponseSchema,
  type ProviderCatalogEntry,
} from "@fretik/shared/schemas/external-apps";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `GET /external-apps/providers` — catalogue of the external apps Fretik
 * supports. Read straight from the in-memory registry: no DB, no Nango
 * round-trip. Used by the settings UI's "Add connection" modal to render
 * the provider picker, and by future approval cards that want to look up
 * an action's `kind` (read vs write) without re-deriving it from the
 * tool result.
 */

const providersRoutes = new OpenAPIHono<HonoLoggedAppType>();
providersRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List external-app providers supported by Fretik",
  description:
    "Returns the provider catalogue (key, displayName, icon, scopes, actions). The actions list includes `kind` (read vs write) and a one-line `summary` so the frontend can preview capabilities without pulling the full manifest. Auth-required so the route is consistent with the rest of `/external-apps/*`; the catalogue itself is not team-specific.",
  tags: ["ExternalApps"],
  responses: {
    200: {
      content: { "application/json": { schema: providersListResponseSchema } },
      description: "Provider catalogue",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

providersRoutes.openapi(listRoute, (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const manifests = listProviderManifests();
  const providers: ProviderCatalogEntry[] = manifests.map((m) => ({
    key: m.key,
    displayName: m.displayName,
    icon: m.icon,
    iconColor: m.iconColor,
    scopes: m.scopes,
    transport: m.transport,
    // `credentialsForm` is only present on `custom-handler` providers —
    // the frontend keys off `transport.kind` to decide which connect
    // flow to render (Connect UI vs DynamicCredentialsForm).
    credentialsForm: m.credentialsForm,
    connectionOptions: m.connectionOptions,
    requiresAdminConsent: m.requiresAdminConsent,
    categories: m.categories,
    actions: m.actions.map((a) => ({
      name: a.name,
      kind: a.kind,
      summary: a.summary,
    })),
  }));

  return c.json({ providers }, 200);
});

export { providersRoutes };
