import type { ExternalAppConnection } from "@fretik/shared/db/schema";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { forbidden, teamRequired } from "@fretik/shared/lib/errors";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  confirmConnectionRequestSchema,
  connectionConfigResponseSchema,
  connectSessionRequestSchema,
  connectSessionResponseSchema,
  deleteConnectionResponseSchema,
  dynamicOptionsRequestSchema,
  dynamicOptionsResponseSchema,
  externalAppConnectionResponseSchema,
  externalAppConnectionsListResponseSchema,
  testCredentialsRequestSchema,
  testCredentialsResponseSchema,
  updateConnectionRequestSchema,
  type ExternalAppConnectionResponse,
} from "@fretik/shared/schemas/external-apps";
import { confirmConnection } from "@fretik/shared/services/external-apps/connections/confirm";
import { confirmReconnect } from "@fretik/shared/services/external-apps/connections/confirm-reconnect";
import { createConnectSession } from "@fretik/shared/services/external-apps/connections/create-connect-session";
import { createReconnectSession } from "@fretik/shared/services/external-apps/connections/create-reconnect-session";
import { deleteConnection } from "@fretik/shared/services/external-apps/connections/delete";
import { fetchDynamicOptions } from "@fretik/shared/services/external-apps/connections/fetch-dynamic-options";
import { getConnectionForCaller } from "@fretik/shared/services/external-apps/connections/get-by-id";
import { getConnectionConfigForReconnect } from "@fretik/shared/services/external-apps/connections/get-connection-config";
import { listConnections } from "@fretik/shared/services/external-apps/connections/list";
import { testConnectionCredentials } from "@fretik/shared/services/external-apps/connections/test-credentials";
import { updateConnection } from "@fretik/shared/services/external-apps/connections/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/external-apps/connect-session` + `/external-apps/connections/*` — the
 * full CRUD for the user-visible connection list in Settings, plus the
 * Nango Connect Session bootstrap.
 *
 * The OAuth flow itself happens in the browser via `@nangohq/frontend`:
 *  1. Frontend calls `POST /connect-session` → gets a session token.
 *  2. `nango.openConnectUI({ sessionToken })` opens Nango's hosted UI.
 *  3. On `onEvent({ type: 'connect' })`, the frontend POSTs the new
 *     `connectionId` back to `POST /external-apps/connections` to upsert
 *     a Fretik-side row.
 *
 * Nango free self-hosted does NOT emit webhooks, so the post-Connect POST
 * is the only place we record the connection's existence. We re-verify
 * the connection via `nango.getConnection(...)` to defend against a
 * hostile client posting a fake `connectionId`.
 */

const connectionsRoutes = new OpenAPIHono<HonoLoggedAppType>();
connectionsRoutes.use("*", authMiddleware);

// ---- DTO mapper ------------------------------------------------------

const toDto = (row: ExternalAppConnection): ExternalAppConnectionResponse => ({
  id: row.id,
  providerKey: row.providerKey,
  displayName: row.displayName,
  scope: row.userId === null ? "team" : "user",
  status: row.status,
  options: row.options,
  lastErrorMessage: row.lastErrorMessage,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// ---- Routes ---------------------------------------------------------

const connectSessionRoute = createRoute({
  method: "post",
  path: "/connect-session",
  // (mounted at the root of `/external-apps`, so this lands at
  // `POST /external-apps/connect-session`).
  summary: "Mint a Nango Connect session for the frontend OAuth flow",
  description:
    "Creates a short-lived Connect session token bound to the active team and user. The frontend feeds it to `@nangohq/frontend`'s Connect UI; the underlying Nango integration is selected from the requested `providerKey`. The returned `connectLink` is the hosted alternative when the embedded UI cannot be used.",
  tags: ["ExternalApps"],
  request: {
    body: {
      content: { "application/json": { schema: connectSessionRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: connectSessionResponseSchema } },
      description: "Connect session token",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/connections",
  summary: "Confirm and store a Nango connection after Connect UI completes",
  description:
    "Called by the frontend right after Nango's Connect UI fires `onEvent({ type: 'connect' })`. The handler verifies the `nangoConnectionId` via `nango.getConnection(...)` (defense against fake IDs) then inserts a Fretik-side row with the chosen `scope` and `displayName`.",
  tags: ["ExternalApps"],
  request: {
    body: {
      content: {
        "application/json": { schema: confirmConnectionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: externalAppConnectionResponseSchema },
      },
      description: "Connection created",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/connections",
  summary: "List external-app connections the caller can use",
  description:
    "Returns every team-scoped connection (shared with everyone in the team) plus the caller's user-scoped connections. Newest first.",
  tags: ["ExternalApps"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: externalAppConnectionsListResponseSchema,
        },
      },
      description: "Connections list",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getOneRoute = createRoute({
  method: "get",
  path: "/connections/{id}",
  summary: "Fetch a single connection",
  tags: ["ExternalApps"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: externalAppConnectionResponseSchema },
      },
      description: "Connection",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/connections/{id}",
  summary: "Rename a connection or flip its status",
  description:
    "Partial update — send any combination of `displayName` and `status`. Flipping `status` to `active` clears `lastErrorMessage` (typical recovery after a manual reconnect).",
  tags: ["ExternalApps"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: updateConnectionRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: externalAppConnectionResponseSchema },
      },
      description: "Connection updated",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const testCredentialsRoute = createRoute({
  method: "post",
  path: "/connections/test-credentials",
  summary: "Validate user-supplied credentials before storing them in Nango",
  description:
    "Generic credential-testing endpoint for `custom-handler` providers (IMAP/SMTP today; future API-key / SDK-only providers). Receives the provider key plus the raw `credentials` and `connection_config` field values from the descriptor-driven form, dispatches to the provider's own `testCredentials` implementation, and returns a granular `{ ok, scope?, message? }` so the UI can tell the user which side (IMAP vs SMTP, auth vs network) failed.",
  tags: ["ExternalApps"],
  request: {
    body: {
      content: {
        "application/json": { schema: testCredentialsRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: testCredentialsResponseSchema },
      },
      description: "Test result",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const dynamicOptionsRoute = createRoute({
  method: "post",
  path: "/connections/dynamic-options",
  summary:
    "Resolve the options of a `dynamic-select` credential field at form render time",
  description:
    "Provider-agnostic endpoint the descriptor-driven `AddConnectionModal` calls when a `dynamic-select` field's dependencies are all filled. Forwards the in-progress credentials / connection_config to the provider's registered options handler (e.g. Shiptify's `listAccounts` pings `/accounts/` with the user's API key) and returns the option list. NO state is persisted — the connection isn't created yet.",
  tags: ["ExternalApps"],
  request: {
    body: {
      content: {
        "application/json": { schema: dynamicOptionsRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: dynamicOptionsResponseSchema },
      },
      description: "Options list",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const reconnectSessionRoute = createRoute({
  method: "post",
  path: "/connections/{id}/reconnect-session",
  summary: "Mint a Nango Connect session to reconnect an existing connection",
  description:
    "Used when a connection's `status` flipped to `error` (token revoked/expired) OR proactively (e.g. user changed their Microsoft password and wants to refresh credentials before the next failure). Returns a short-lived session token bound to the existing `nangoConnectionId` — preserves the row's `id`, `displayName`, `options`, and audit trail. Works for both OAuth (`nango-proxy`) and headless (`custom-handler`) providers; the frontend branches on transport.",
  tags: ["ExternalApps"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: connectSessionResponseSchema } },
      description: "Reconnect session token",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const reconnectConfirmRoute = createRoute({
  method: "post",
  path: "/connections/{id}/reconnect-confirm",
  summary: "Finalise a reconnect after Connect UI fires the connect event",
  description:
    "Re-verifies the Nango connection still exists post-reconnect, then flips `status` back to `active` and clears `lastErrorMessage`. A `disabled` row stays `disabled` (Nango credentials are still refreshed, but the user must explicitly re-enable from the settings UI).",
  tags: ["ExternalApps"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: externalAppConnectionResponseSchema },
      },
      description: "Connection reconnected",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const connectionConfigRoute = createRoute({
  method: "get",
  path: "/connections/{id}/connection-config",
  summary: "Fetch non-sensitive connection_config to pre-fill reconnect form",
  description:
    "Returns only the fields declared with `target: 'connection_config'` in the provider's `credentialsForm` descriptor (IMAP/SMTP host/port, etc.). Fields with `target: 'credentials'` (password, API key) are filtered out — they never leave Nango. Only meaningful for `custom-handler` providers; returns 400 for OAuth.",
  tags: ["ExternalApps"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: connectionConfigResponseSchema },
      },
      description: "Non-sensitive connection_config",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/connections/{id}",
  summary: "Delete a connection (revokes the Nango connection too)",
  description:
    "Revokes the OAuth grant in Nango (best-effort — a 404 or transient error never blocks the local delete) then drops the Fretik row. Any `pending` approvals referencing this connection stay visible in audit.",
  tags: ["ExternalApps"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: deleteConnectionResponseSchema },
      },
      description: "Connection deleted",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

// ---- Handlers --------------------------------------------------------

connectionsRoutes.openapi(connectSessionRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { providerKey, adminConsent } = c.req.valid("json");
  const session = await createConnectSession({
    teamId: team.id,
    userId: user.id,
    userEmail: user.email,
    providerKey,
    adminConsent,
  });
  return c.json(session, 200);
});

connectionsRoutes.openapi(confirmRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const body = c.req.valid("json");
  const row = await confirmConnection({
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    scope: body.scope,
    providerKey: body.providerKey,
    displayName: body.displayName,
    nangoConnectionId: body.nangoConnectionId,
    options: body.options,
  });
  return c.json(toDto(row), 201);
});

connectionsRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const rows = await listConnections(team.id, user.id);
  return c.json({ connections: rows.map(toDto) }, 200);
});

connectionsRoutes.openapi(getOneRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const row = await getConnectionForCaller(id, team.id, user.id);
  return c.json(toDto(row), 200);
});

connectionsRoutes.openapi(updateRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const patch = c.req.valid("json");
  const row = await updateConnection({
    id,
    teamId: team.id,
    userId: user.id,
    displayName: patch.displayName,
    status: patch.status,
    options: patch.options,
  });
  return c.json(toDto(row), 200);
});

connectionsRoutes.openapi(testCredentialsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const body = c.req.valid("json");
  const result = await testConnectionCredentials({
    providerKey: body.providerKey,
    credentials: body.credentials,
    connectionConfig: body.connectionConfig,
  });
  return c.json(result, 200);
});

connectionsRoutes.openapi(dynamicOptionsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const body = c.req.valid("json");
  const result = await fetchDynamicOptions({
    providerKey: body.providerKey,
    fieldKey: body.fieldKey,
    credentials: body.credentials,
    connectionConfig: body.connectionConfig,
  });
  return c.json(result, 200);
});

connectionsRoutes.openapi(reconnectSessionRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const session = await createReconnectSession({
    connectionId: id,
    teamId: team.id,
    userId: user.id,
    userEmail: user.email,
  });
  return c.json(session, 200);
});

connectionsRoutes.openapi(reconnectConfirmRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const row = await confirmReconnect({
    connectionId: id,
    teamId: team.id,
    userId: user.id,
  });
  return c.json(toDto(row), 200);
});

connectionsRoutes.openapi(connectionConfigRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const connectionConfig = await getConnectionConfigForReconnect({
    connectionId: id,
    teamId: team.id,
    userId: user.id,
  });
  return c.json({ connectionConfig }, 200);
});

connectionsRoutes.openapi(deleteRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  await deleteConnection({ id, teamId: team.id, userId: user.id });
  return c.json({ id, deleted: true as const }, 200);
});

export { connectionsRoutes };
