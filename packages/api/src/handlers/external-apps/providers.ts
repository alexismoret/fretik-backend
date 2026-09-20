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
  includeSignaturesQuerySchema,
  providersListResponseSchema,
  type ProviderActionEntry,
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
    "Returns the provider catalogue (key, displayName, icon, scopes, actions). The actions list includes `kind` (read vs write) and a one-line `summary` so the frontend can preview capabilities without pulling the full manifest. Pass `includeSignatures=true` to also get, for READ actions only, their `params`, `returns`, and the sync capabilities (`pagination`, `batch`, `incremental`) plus the provider's `types` table — everything a form needs to be generated from the manifest rather than hand-written. It is opt-in because it multiplies the payload of a route that most callers fetch only to draw the provider picker. Auth-required so the route is consistent with the rest of `/external-apps/*`; the catalogue itself is not team-specific.",
  tags: ["ExternalApps"],
  request: { query: includeSignaturesQuerySchema },
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
  const { includeSignatures } = c.req.valid("query");

  // `testOnly` providers exist for the eval suites and have no third party
  // behind them — offering one in the connect catalogue would be offering an
  // app that does not exist. The registry still holds them, because the SDK
  // generator and the dispatcher must see every provider.
  const manifests = listProviderManifests().filter((m) => m.testOnly !== true);
  const providers: ProviderCatalogEntry[] = manifests.map((m) => ({
    key: m.key,
    displayName: m.displayName,
    icon: m.icon,
    iconColor: m.iconColor,
    iconGradient: m.iconGradient,
    scopes: m.scopes,
    transport: m.transport,
    // `credentialsForm` is only present on `custom-handler` providers —
    // the frontend keys off `transport.kind` to decide which connect
    // flow to render (Connect UI vs DynamicCredentialsForm).
    credentialsForm: m.credentialsForm,
    connectionOptions: m.connectionOptions,
    requiresAdminConsent: m.requiresAdminConsent,
    categories: m.categories,
    actions: m.actions.map((a): ProviderActionEntry => {
      const base = { name: a.name, kind: a.kind, summary: a.summary };
      // Writes never carry a signature here, whatever the caller asked for:
      // these fields exist so a client can COMPOSE a call, and a write is
      // composed by the approval path, not by a form.
      if (!includeSignatures || a.kind !== "read") return base;
      // Spread rather than assign — `exactOptionalPropertyTypes` makes an
      // explicit `undefined` a different thing from an absent key, and the
      // response is asserted against the schema key by key.
      return {
        ...base,
        params: a.params,
        returns: a.returns,
        ...(a.pagination === undefined ? {} : { pagination: a.pagination }),
        ...(a.batch === undefined ? {} : { batch: a.batch }),
        ...(a.incremental === undefined ? {} : { incremental: a.incremental }),
      };
    }),
    // Only alongside the signatures: it is the table `returns: {ref}` points at.
    ...(includeSignatures ? { types: m.types } : {}),
  }));

  return c.json({ providers }, 200);
});

export { providersRoutes };
