import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import { forbidden, teamRequired } from "@fretik/shared/lib/errors";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  skillNameParamSchema,
  skillsListResponseSchema,
  skillSummarySchema,
  toggleSkillBodySchema,
} from "@fretik/shared/schemas/skills";
import { listSkillsForTeam } from "@fretik/shared/services/skills/list-for-team";
import { upsertTeamSkillOverride } from "@fretik/shared/services/skills/upsert-team-override";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/team-skills/*` — public catalogue + per-team enable/disable toggle.
 *
 * Read access (GET) is open to any team member: the settings page is
 * read-only for non-admins so users can see what the chatbot is using.
 * Write access (PATCH) is restricted to org owners and admins via the
 * shared `assertOrgAdmin` helper. The always-on guard
 * (`isDefault → 400 SKILL_NOT_TOGGLEABLE`) lives in the service layer
 * so a forged PATCH can't bypass it.
 *
 * The chatbot system prompt does NOT call this handler — it queries
 * `services/skills/list-enabled-for-team.ts` directly to keep the
 * agent's catalogue rendering off the public API surface. The two
 * endpoints share the same DB rows so they never drift.
 */

const teamSkillsRoutes = new OpenAPIHono<HonoLoggedAppType>();
teamSkillsRoutes.use("*", authMiddleware);

// ============================================================================
// Routes
// ============================================================================

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List skills for the active team",
  description:
    "Returns every catalogue skill visible to the team (bundled + future team-uploaded), with the effective `enabled` state after applying any team override. Always-on skills (`isDefault: true`) always report `enabled: true`.",
  tags: ["Skills"],
  responses: {
    200: {
      content: {
        "application/json": { schema: skillsListResponseSchema },
      },
      description: "Skills catalogue",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const toggleRoute = createRoute({
  method: "patch",
  path: "/{name}",
  summary: "Enable or disable a configurable skill for the team",
  description:
    "Upserts the (team, skill) override row. Refuses with `SKILL_NOT_TOGGLEABLE` (400) when the target skill is always-on, and with `SKILL_NOT_FOUND` (404) when the name is unknown for this team's catalogue. Requires owner/admin role.",
  tags: ["Skills"],
  request: {
    params: skillNameParamSchema,
    body: {
      content: {
        "application/json": { schema: toggleSkillBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: skillSummarySchema },
      },
      description: "Skill override applied",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

teamSkillsRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const skills = await listSkillsForTeam(team.id);
  return c.json({ skills }, 200);
});

teamSkillsRoutes.openapi(toggleRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
    message: "Toggling skills requires admin or owner role",
  });

  const { name } = c.req.valid("param");
  const { enabled } = c.req.valid("json");

  const summary = await upsertTeamSkillOverride({
    teamId: team.id,
    skillName: name,
    enabled,
    updatedById: user.id,
  });

  return c.json(summary, 200);
});

export { teamSkillsRoutes };
