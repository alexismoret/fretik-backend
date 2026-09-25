import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired, throwHttpError } from "@fretik/shared/lib/errors";
import { SUPPORTED_LOCALES } from "@fretik/shared/lib/locales";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import { getTeamLocale } from "@fretik/shared/services/field-definitions/get-locale";
import { updateTeamLocale } from "@fretik/shared/services/team-settings/update-locale";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

/**
 * `/team-settings` — team-scoped preferences that live on the `team_settings`
 * extension table (not the Better Auth `team` table). Today just the working
 * UI `lang`. GET is readable by any member; PATCH takes `team.manage` (the
 * team's leads, and organization admins). Changing the team language sets the
 * default for NEW members and localizes team-scoped emails/templates — it
 * never rewrites an existing member's `user.language`.
 */
const teamSettingsRoutes = new OpenAPIHono<HonoLoggedAppType>();
teamSettingsRoutes.use("*", authMiddleware);

const teamLocaleResponseSchema = z
  .object({ lang: z.string() })
  .openapi("TeamLocale");

const teamLocalePatchSchema = z
  .object({ lang: z.enum(SUPPORTED_LOCALES) })
  .openapi("TeamLocalePatch");

const getRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.session(
    "Any member of the active team reads its language.",
  ),
  summary: "Get the team's working UI language",
  tags: ["TeamSettings"],
  responses: {
    200: {
      content: {
        "application/json": { schema: teamLocaleResponseSchema },
      },
      description: "The team's current language code",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/",
  middleware: access.capability("team.manage"),
  summary: "Set the team's working UI language (team leads)",
  description:
    "Updates `team_settings.lang`. Validated against the supported locale set. Does not change any member's personal language.",
  tags: ["TeamSettings"],
  request: {
    body: {
      content: {
        "application/json": { schema: teamLocalePatchSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: teamLocaleResponseSchema },
      },
      description: "Updated language code",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

teamSettingsRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  const lang = await getTeamLocale(team.id);
  return c.json({ lang }, 200);
});

teamSettingsRoutes.openapi(patchRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  const { lang } = c.req.valid("json");
  await updateTeamLocale(team.id, lang);
  return c.json({ lang }, 200);
});

export { teamSettingsRoutes };
