import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  memberParamsSchema,
  organizationMemberSchema,
  organizationMembersSchema,
  pendingInvitationsSchema,
  setOrganizationRoleSchema,
} from "@fretik/shared/schemas/members";
import { cancelInvitation } from "@fretik/shared/services/invitations/cancel";
import { listPendingInvitations } from "@fretik/shared/services/invitations/list-pending";
import { listOrganizationMembers } from "@fretik/shared/services/members/directory";
import { removeOrganizationMember } from "@fretik/shared/services/members/remove";
import { setOrganizationRole } from "@fretik/shared/services/members/set-role";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/members` — the organization's people and its pending invitations, as the
 * Members page manages them.
 *
 * Every member reads the directory (guests are refused it: they see only the
 * people they work with). Changing someone's organization role or removing
 * them is the admins' (`members.manage`), and goes through our services
 * rather than Better Auth's endpoints so each change is journaled with who
 * made it. Inviting is a team's business (`POST /teams/{id}/invitations`);
 * withdrawing an invitation is here, decided by the invitation's own team.
 */
const memberRoutes = new OpenAPIHono<HonoLoggedAppType>();
memberRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.capability("directory.read"),
  summary: "List the organization's people",
  description:
    "Everyone in the organization with their role, their teams and their role in each. Not paged and not capped; the team agents' accounts are not listed.",
  tags: ["Members"],
  responses: {
    200: {
      content: { "application/json": { schema: organizationMembersSchema } },
      description: "The organization's people, by name",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const setRoleRoute = createRoute({
  method: "patch",
  path: "/{userId}",
  middleware: access.capability("members.manage"),
  summary: "Make someone an admin of the organization, or a member again",
  description:
    "An owner is changed only by an owner, and the last owner never. Applies to every open session on its next request.",
  tags: ["Members"],
  request: {
    params: memberParamsSchema,
    body: {
      content: { "application/json": { schema: setOrganizationRoleSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: organizationMemberSchema } },
      description: "The person, with their new role",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: "/{userId}",
  middleware: access.capability("members.manage"),
  summary: "Remove someone from the organization",
  description:
    "And so from every team of it. An owner is removed only by another owner; leaving on one's own is Better Auth's `/organization/leave`.",
  tags: ["Members"],
  request: { params: memberParamsSchema },
  responses: {
    204: { description: "Removed" },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/invitations",
  middleware: access.capability("members.manage"),
  summary: "Every pending invitation of the organization",
  tags: ["Members"],
  responses: {
    200: {
      content: { "application/json": { schema: pendingInvitationsSchema } },
      description: "Pending invitations, newest first",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const cancelInvitationRoute = createRoute({
  method: "delete",
  path: "/invitations/{id}",
  middleware: access.handler(
    "Whoever may invite into the invitation's team (members.invite there); one with no team takes members.manage (cancelInvitation).",
  ),
  summary: "Withdraw a pending invitation",
  tags: ["Members"],
  request: { params: paramsIdSchema },
  responses: {
    204: { description: "Withdrawn" },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

memberRoutes.openapi(listRoute, async (c) => {
  const members = await listOrganizationMembers(
    c.get("principal").organizationId,
  );
  return c.json({ members }, 200);
});

memberRoutes.openapi(setRoleRoute, async (c) => {
  const { userId } = c.req.valid("param");
  const { role } = c.req.valid("json");
  const updated = await setOrganizationRole({
    principal: c.get("principal"),
    userId,
    role,
  });
  return c.json(updated, 200);
});

memberRoutes.openapi(removeRoute, async (c) => {
  const { userId } = c.req.valid("param");
  await removeOrganizationMember({ principal: c.get("principal"), userId });
  return c.body(null, 204);
});

memberRoutes.openapi(listInvitationsRoute, async (c) => {
  const invitations = await listPendingInvitations({
    organizationId: c.get("principal").organizationId,
  });
  return c.json({ invitations }, 200);
});

memberRoutes.openapi(cancelInvitationRoute, async (c) => {
  const { id } = c.req.valid("param");
  await cancelInvitation({ principal: c.get("principal"), invitationId: id });
  return c.body(null, 204);
});

export { memberRoutes };
