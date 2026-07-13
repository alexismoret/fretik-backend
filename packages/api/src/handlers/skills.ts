import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import {
  forbidden,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { ERROR_CODES } from "@fretik/shared/schemas/errors";
import {
  createSkillRequestSchema,
  installSkillRequestSchema,
  skillCatalogDetailQuerySchema,
  skillCatalogDetailSchema,
  skillCatalogQuerySchema,
  skillCatalogResponseSchema,
  skillDetailSchema,
  skillIdParamSchema,
  skillsListResponseSchema,
  updateSkillRequestSchema,
} from "@fretik/shared/schemas/skills";
import { getSkillCatalogDetail } from "@fretik/shared/services/skills/catalog-detail";
import { createSkill } from "@fretik/shared/services/skills/create";
import { deleteSkill } from "@fretik/shared/services/skills/delete";
import { getSkillForTeamById } from "@fretik/shared/services/skills/get-by-id";
import { installSkillFromCatalog } from "@fretik/shared/services/skills/install-from-catalog";
import { listSkillsForTeam } from "@fretik/shared/services/skills/list-for-team";
import { searchSkillCatalog } from "@fretik/shared/services/skills/search-catalog";
import { updateSkill } from "@fretik/shared/services/skills/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/skills/*` — single REST resource covering the whole skill
 * lifecycle for a team.
 *
 *  GET    /skills        list catalogue (bundled + team_uploaded),
 *                        body excluded, effective `enabled` resolved.
 *                        Open to any team member.
 *  GET    /skills/:id    fetch one with body (for the settings
 *                        editor). Open to any team member.
 *  POST   /skills        create a new team_uploaded skill (markdown
 *                        body). Org admin/owner only.
 *  PATCH  /skills/:id    update any combination of description, body,
 *                        and enabled. Toggle is the enabled-only
 *                        case. Bundled skills accept only enabled.
 *                        Org admin/owner only.
 *  DELETE /skills/:id    soft-delete a team_uploaded skill. Bundled
 *                        skills cannot be deleted. Org admin/owner.
 *
 * The chatbot system prompt does NOT call this handler — it queries
 * `services/skills/list-enabled-for-team` directly to keep the
 * agent's catalogue rendering off the public API surface. Both paths
 * share the same DB rows so they never drift.
 */

const skillsRoutes = new OpenAPIHono<HonoLoggedAppType>();
skillsRoutes.use("*", authMiddleware);

// ============================================================================
// Routes
// ============================================================================

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List skills available to the active team",
  description:
    "Returns every catalogue skill visible to the team (bundled + team_uploaded), with the effective `enabled` state after applying any team override. Always-on skills (`isDefault: true`) always report `enabled: true`. Body is excluded — fetch a single skill via `GET /skills/:id` to get the markdown body for the editor.",
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

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Fetch one skill (including markdown body) for the settings editor",
  description:
    "Returns the full skill detail including the `body` field. Scoped to skills visible to the active team: bundled skills (read-only) or team_uploaded skills owned by this team. 404 when the id doesn't match either.",
  tags: ["Skills"],
  request: { params: skillIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: skillDetailSchema } },
      description: "Skill detail",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "",
  summary: "Create a team-uploaded skill",
  description:
    'Requires admin/owner role. The `name` field is slugified server-side and deduplicated against bundled + this team\'s existing team_uploaded skills, so `"Extract DAE CSV"` becomes `"extract-dae-csv"` (or `"extract-dae-csv-2"` on collision). The new skill is created in the enabled state; toggle via `PATCH /skills/:id` to disable.',
  tags: ["Skills"],
  request: {
    body: {
      content: { "application/json": { schema: createSkillRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: skillDetailSchema } },
      description: "Skill created",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a skill — any combination of description, body, enabled",
  description:
    "Requires admin/owner role. Partial update: send only the fields to change. Send `{ enabled: false }` to disable, `{ body: '…' }` to edit content, `{ description: '…', enabled: true }` to do both at once. Bundled skills accept only `enabled` (their body lives on disk). Always-on skills reject `enabled` patches with `SKILL_NOT_TOGGLEABLE`. Bumps semver patch when body changes.",
  tags: ["Skills"],
  request: {
    params: skillIdParamSchema,
    body: {
      content: { "application/json": { schema: updateSkillRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: skillDetailSchema } },
      description: "Skill updated",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Soft-delete a team-uploaded skill",
  description:
    "Requires admin/owner role. Sets `deleted_at`; existing team_skills override rows are preserved so a manual restore recovers the previous toggle state. Bundled skills cannot be deleted.",
  tags: ["Skills"],
  request: { params: skillIdParamSchema },
  responses: {
    204: { description: "Skill deleted" },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const catalogRouteDef = createRoute({
  method: "get",
  path: "/catalog",
  summary: "Search the skill catalog (skills.sh, discovery-only)",
  description:
    "Searches the skills.sh catalog (metadata only — no user data transits it). Paginated and searchable via `q`. With no `q`, returns the official shelf (Anthropic + OpenAI skills). Each entry's `description` is hydrated from the skill's SKILL.md; `official` and `filesCount` come from the same source.",
  tags: ["Skills"],
  request: { query: skillCatalogQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: skillCatalogResponseSchema } },
      description: "Skill catalog page",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const catalogDetailRouteDef = createRoute({
  method: "get",
  path: "/catalog/detail",
  summary: "Fetch a catalog skill's license + advisory audits",
  description:
    "Returns the skill's license (with a `restrictedLicense` flag the UI uses to block install of proprietary content) and advisory security audits for the detail panel. Never installs anything.",
  tags: ["Skills"],
  request: { query: skillCatalogDetailQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: skillCatalogDetailSchema } },
      description: "Skill catalog detail",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const installRouteDef = createRoute({
  method: "post",
  path: "/install",
  summary: "Install a catalog skill to the active team",
  description:
    "Requires admin/owner role. Downloads the catalog skill's full SKILL.md body and creates a team_uploaded skill stamped with its `skills.sh:<owner>/<repo>/<slug>` provenance. Idempotent — re-installing the same skill returns the existing row. Refuses skills whose license forbids storing/redistributing their content.",
  tags: ["Skills"],
  request: {
    body: {
      content: { "application/json": { schema: installSkillRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: skillDetailSchema } },
      description: "Skill installed",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ============================================================================
// Handlers
// ============================================================================

skillsRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const skills = await listSkillsForTeam(team.id);
  return c.json({ skills }, 200);
});

skillsRoutes.openapi(catalogRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const { q, page, pageSize } = c.req.valid("query");
  const result = await searchSkillCatalog({ q, page, pageSize });
  return c.json(result, 200);
});

skillsRoutes.openapi(catalogDetailRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const { owner, repo, slug } = c.req.valid("query");
  const detail = await getSkillCatalogDetail({ owner, repo, slug });
  return c.json(detail, 200);
});

skillsRoutes.openapi(installRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
    message: "Installing skills requires admin or owner role",
  });

  const { owner, repo, slug } = c.req.valid("json");
  const installed = await installSkillFromCatalog({
    teamId: team.id,
    organizationId: team.organizationId,
    owner,
    repo,
    slug,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(installed, 201);
});

skillsRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const { id } = c.req.valid("param");
  const skill = await getSkillForTeamById(id, team.id);
  if (!skill) {
    return throwHttpError(404, {
      code: ERROR_CODES.SKILL_NOT_FOUND,
      message: "Skill not found for this team",
    });
  }
  return c.json(skill, 200);
});

skillsRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
    message: "Creating skills requires admin or owner role",
  });

  const body = c.req.valid("json");
  const created = await createSkill({
    teamId: team.id,
    organizationId: team.organizationId,
    name: body.name,
    description: body.description,
    body: body.body,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(created, 201);
});

skillsRoutes.openapi(updateRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
    message: "Updating skills requires admin or owner role",
  });

  const { id } = c.req.valid("param");
  const patch = c.req.valid("json");
  const updated = await updateSkill({
    id,
    teamId: team.id,
    updatedById: user.id,
    description: patch.description,
    body: patch.body,
    enabled: patch.enabled,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.json(updated, 200);
});

skillsRoutes.openapi(deleteRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);

  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
    message: "Deleting skills requires admin or owner role",
  });

  const { id } = c.req.valid("param");
  await deleteSkill({
    id,
    teamId: team.id,
    actor: { actorType: "user", actorUserId: user.id },
  });
  return c.body(null, 204);
});

export { skillsRoutes };
