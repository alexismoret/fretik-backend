import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired } from "@fretik/shared/lib/errors";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  createPinRequestSchema,
  pinListResponseSchema,
  pinOkResponseSchema,
  pinTargetSchema,
  reorderPinsRequestSchema,
} from "@fretik/shared/schemas/pins";
import { listUserPins } from "@fretik/shared/services/pins/list";
import { pinTarget } from "@fretik/shared/services/pins/pin";
import { reorderUserPins } from "@fretik/shared/services/pins/reorder";
import { unpinTarget } from "@fretik/shared/services/pins/unpin";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * Pins — the caller's personal sidebar shortcuts inside the team they are
 * working in. Thin wrappers over `@fretik/shared/services/pins/*`: this file
 * resolves the caller's team and formats responses, nothing more.
 *
 * Every route is scoped to `(user, team)` from the session — the caller never
 * names whose pins they are touching. What a pin points at is resolved through
 * the access engine with the caller's principal, so a pin shows (and can be
 * created) only for what the caller may open.
 */

const pinRoutes = new OpenAPIHono<HonoLoggedAppType>();
pinRoutes.use("*", authMiddleware);

const OWN_PINS = access.session(
  "The caller's own pins in the active team; targets resolve through the engine.",
);

// ---- Routes ----------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  middleware: OWN_PINS,
  summary: "List the caller's pins",
  description:
    "In the caller's chosen order, and already carrying what the sidebar draws (label, icon, color, route key) so rendering needs no follow-up request. Targets that no longer exist are reaped; targets that exist but are currently invisible or disabled are omitted and come back when they become visible again.",
  tags: ["Pins"],
  responses: {
    200: {
      content: { "application/json": { schema: pinListResponseSchema } },
      description: "Pins",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  middleware: OWN_PINS,
  summary: "Pin a target",
  description:
    "Idempotent: re-pinning keeps the entry where it is instead of moving it to the end. A target the caller cannot see answers 404, exactly like opening it would.",
  tags: ["Pins"],
  request: {
    body: {
      content: { "application/json": { schema: createPinRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: pinOkResponseSchema } },
      description: "Pinned",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const reorderRoute = createRoute({
  method: "post",
  path: "/reorder",
  middleware: OWN_PINS,
  summary: "Reorder the caller's pins",
  description:
    "Takes the FULL list in its new order — a partial payload is refused, because ordering rewrites every position and the omitted rows would keep colliding indices.",
  tags: ["Pins"],
  request: {
    body: {
      content: { "application/json": { schema: reorderPinsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: pinOkResponseSchema } },
      description: "Reordered",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{targetType}/{targetId}",
  middleware: OWN_PINS,
  summary: "Unpin a target",
  description:
    "Idempotent — unpinning something that is not pinned succeeds, so the UI can fire the toggle optimistically.",
  tags: ["Pins"],
  request: { params: pinTargetSchema },
  responses: {
    200: {
      content: { "application/json": { schema: pinOkResponseSchema } },
      description: "Unpinned",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

// ---- Handlers --------------------------------------------------------

pinRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const data = await listUserPins({
    principal: c.get("principal"),
    teamId: team.id,
  });
  return c.json({ data }, 200);
});

pinRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  await pinTarget({
    principal: c.get("principal"),
    teamId: team.id,
    target: c.req.valid("json"),
  });
  return c.json({ ok: true }, 201);
});

pinRoutes.openapi(reorderRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { items } = c.req.valid("json");
  await reorderUserPins({ userId: user.id, teamId: team.id, items });
  return c.json({ ok: true }, 200);
});

pinRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const target = c.req.valid("param");
  await unpinTarget({ userId: user.id, teamId: team.id, target });
  return c.json({ ok: true }, 200);
});

export { pinRoutes };
