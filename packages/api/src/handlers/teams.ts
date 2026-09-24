import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  teamAccessPolicyPatchSchema,
  teamAccessPolicySchema,
} from "@fretik/shared/schemas/access-policy";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  invitationOutcomesSchema,
  inviteToTeamSchema,
  pendingInvitationsSchema,
} from "@fretik/shared/schemas/members";
import {
  addTeamMembersSchema,
  createTeamSchema,
  renameTeamSchema,
  setTeamMemberRoleSchema,
  teamDetailSchema,
  teamMemberParamsSchema,
  teamRosterSchema,
  teamsListSchema,
  teamSummarySchema,
} from "@fretik/shared/schemas/teams";
import { inviteToTeam } from "@fretik/shared/services/invitations/invite-to-team";
import { listPendingInvitations } from "@fretik/shared/services/invitations/list-pending";
import { addTeamMembers } from "@fretik/shared/services/team/add-members";
import { createTeam } from "@fretik/shared/services/team/create";
import { getTeamDetail } from "@fretik/shared/services/team/detail";
import { listOrganizationTeams } from "@fretik/shared/services/team/directory";
import { removeTeamMember } from "@fretik/shared/services/team/remove-member";
import { renameTeam } from "@fretik/shared/services/team/rename";
import { setTeamPolicy } from "@fretik/shared/services/team/set-policy";
import { setTeamMemberRole } from "@fretik/shared/services/team/set-role";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/teams` — the organization's teams as its settings manage them: who is in
 * each, with which role, and what a member gets on the team's content.
 *
 * A team is managed from anywhere, not only while it is the active one: every
 * rule about ONE team is decided in the team the path names
 * (`access.teamCapability`), where a team's leads — and the organization's
 * admins, who lead every team — may act. A team of another organization
 * answers 404 before any role is looked at.
 *
 * Creating a team and changing its people go through our services rather
 * than Better Auth's endpoints, whose permissions are organization roles only
 * and whose hooks do not know who acted. Deleting a team stays Better Auth's
 * (`/auth/organization/remove-team`, admins only).
 */
const teamRoutes = new OpenAPIHono<HonoLoggedAppType>();
teamRoutes.use("*", authMiddleware);

const DIRECTORY = access.capability("directory.read");

const listRoute = createRoute({
  method: "get",
  path: "/",
  middleware: DIRECTORY,
  summary: "List the organization's teams",
  description:
    "Every team, with how many people it holds and the caller's own role in it (null when they are not in it). Knowing a team exists opens nothing in it.",
  tags: ["Teams"],
  responses: {
    200: {
      content: { "application/json": { schema: teamsListSchema } },
      description: "The organization's teams, by name",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createTeamRoute = createRoute({
  method: "post",
  path: "/",
  middleware: access.capability("teams.create"),
  summary: "Create a team, led by its creator",
  tags: ["Teams"],
  request: {
    body: {
      content: { "application/json": { schema: createTeamSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: teamSummarySchema } },
      description: "The new team",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  middleware: DIRECTORY,
  summary: "One team: its people, its defaults, what the caller may do in it",
  tags: ["Teams"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: teamDetailSchema } },
      description: "The team",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const renameRoute = createRoute({
  method: "patch",
  path: "/{id}",
  middleware: access.teamCapability("team.manage"),
  summary: "Rename a team",
  tags: ["Teams"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: renameTeamSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: teamDetailSchema } },
      description: "The team, renamed",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const policyRoute = createRoute({
  method: "patch",
  path: "/{id}/policy",
  middleware: access.teamCapability("team.manage"),
  summary: "Change a team's access defaults",
  description:
    "Sparse: only the settings sent change. What a member (not a lead, not a viewer) gets on the team's content applies to every open session on its next request.",
  tags: ["Teams"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: teamAccessPolicyPatchSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: teamAccessPolicySchema } },
      description: "The team's policy, resolved",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const addMembersRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  middleware: access.teamCapability("team.members.manage"),
  summary: "Add people of the organization to a team",
  description:
    "Only members of the organization join a team this way; someone already in it keeps their role. Stops at the team's seat limit (409), keeping whoever joined before it.",
  tags: ["Teams"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: addTeamMembersSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: teamRosterSchema } },
      description: "The team's people",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const setRoleRoute = createRoute({
  method: "patch",
  path: "/{id}/members/{userId}",
  middleware: access.teamCapability("team.members.manage"),
  summary: "Set someone's role in a team: lead, member or viewer",
  tags: ["Teams"],
  request: {
    params: teamMemberParamsSchema,
    body: {
      content: { "application/json": { schema: setTeamMemberRoleSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: teamRosterSchema } },
      description: "The team's people",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{userId}",
  middleware: access.handler(
    "Anyone may leave a team; taking someone else out takes team.members.manage in it (removeTeamMember).",
  ),
  summary: "Take someone out of a team, or leave it",
  description:
    "Only the team: they stay in the organization and its other teams, and keep what is shared with them directly.",
  tags: ["Teams"],
  request: { params: teamMemberParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: teamRosterSchema } },
      description: "The team's people",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/{id}/invitations",
  middleware: access.teamCapability("members.invite"),
  summary: "Pending invitations into a team",
  tags: ["Teams"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: pendingInvitationsSchema } },
      description: "Pending invitations, newest first",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const inviteRoute = createRoute({
  method: "post",
  path: "/{id}/invitations",
  middleware: access.teamCapability("members.invite"),
  summary: "Invite people into a team by email",
  description:
    "New people join the organization on accepting; people already in it gain one more team and keep their role. Inviting someone as an admin takes members.manage. One outcome per address.",
  tags: ["Teams"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: inviteToTeamSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: invitationOutcomesSchema } },
      description: "What became of each address",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

teamRoutes.openapi(listRoute, async (c) => {
  const teams = await listOrganizationTeams(c.get("principal"));
  return c.json({ teams }, 200);
});

teamRoutes.openapi(createTeamRoute, async (c) => {
  const { name } = c.req.valid("json");
  const created = await createTeam({ principal: c.get("principal"), name });
  return c.json(created, 201);
});

teamRoutes.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  const detail = await getTeamDetail({
    principal: c.get("principal"),
    teamId: id,
  });
  return c.json(detail, 200);
});

teamRoutes.openapi(renameRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { name } = c.req.valid("json");
  const principal = c.get("principal");
  await renameTeam({ principal, teamId: id, name });
  return c.json(await getTeamDetail({ principal, teamId: id }), 200);
});

teamRoutes.openapi(policyRoute, async (c) => {
  const { id } = c.req.valid("param");
  const patch = c.req.valid("json");
  const policy = await setTeamPolicy({
    principal: c.get("principal"),
    teamId: id,
    patch,
  });
  return c.json(policy, 200);
});

teamRoutes.openapi(addMembersRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { userIds, role } = c.req.valid("json");
  const members = await addTeamMembers({
    principal: c.get("principal"),
    teamId: id,
    userIds,
    role,
  });
  return c.json({ members }, 200);
});

teamRoutes.openapi(setRoleRoute, async (c) => {
  const { id, userId } = c.req.valid("param");
  const { role } = c.req.valid("json");
  const members = await setTeamMemberRole({
    principal: c.get("principal"),
    teamId: id,
    userId,
    role,
  });
  return c.json({ members }, 200);
});

teamRoutes.openapi(removeMemberRoute, async (c) => {
  const { id, userId } = c.req.valid("param");
  const members = await removeTeamMember({
    principal: c.get("principal"),
    teamId: id,
    userId,
  });
  return c.json({ members }, 200);
});

teamRoutes.openapi(listInvitationsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const invitations = await listPendingInvitations({
    organizationId: c.get("principal").organizationId,
    teamId: id,
  });
  return c.json({ invitations }, 200);
});

teamRoutes.openapi(inviteRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { invitations } = c.req.valid("json");
  const outcomes = await inviteToTeam({
    principal: c.get("principal"),
    teamId: id,
    invitations,
  });
  return c.json({ outcomes }, 200);
});

export { teamRoutes };
