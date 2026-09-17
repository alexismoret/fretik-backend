import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { z } from "zod";

import { acceptTeamInvitationForMember } from "../services/invitations/accept-team-invitation";
import { inviteMemberToTeam } from "../services/invitations/invite-member-to-team";

/**
 * Better Auth request hooks.
 *
 * One job today: make "invite an existing organization member to one more
 * team" work. The organization plugin answers that request with
 * `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` — correct for an
 * organization invitation, wrong once `teams.enabled` makes a team a separate
 * grant — and its accept endpoint would write a SECOND `member` row for
 * someone who already has one.
 *
 * Both live inside the plugin's endpoints, so neither `organizationHooks` nor
 * a route of our own can reach them: `beforeCreateInvitation` runs AFTER the
 * guard that refuses, and `beforeAcceptInvitation` cannot stop the
 * `createMember()` that follows it. A `before` hook whose return value is not
 * a `{ context }` patch short-circuits the endpoint entirely — the one seam
 * that sits in front of both.
 *
 * The hook OWNS a request only when every one of these holds; anything else
 * returns `undefined` and Better Auth's own handler runs untouched:
 *   - the path is one of the two endpoints below,
 *   - the body carries exactly the shape the team case needs,
 *   - there is a session,
 *   - the invited address already belongs to the organization (invite) / the
 *     caller already belongs to it (accept).
 *
 * That last condition is what keeps the ordinary invitation — a person with no
 * account, or an account outside the organization — on the plugin's own code
 * path, where it belongs.
 */

/**
 * A team invitation, and nothing else. A body with no `teamId`, or with the
 * array form the UI never sends, fails to parse here and falls through: those
 * are organization invitations and Better Auth serves them.
 */
const inviteMemberBodySchema = z.object({
  email: z.string().min(1),
  teamId: z.string().min(1),
  organizationId: z.string().min(1).optional(),
});

const acceptInvitationBodySchema = z.object({
  invitationId: z.string().min(1),
});

/** The one session field the organization plugin adds that we read here. */
interface OrganizationSessionFields {
  activeOrganizationId?: string | null;
}

/** Messages mirroring Better Auth's ORGANIZATION_ERROR_CODES, which the plugin does not export. */
const ERROR_MESSAGES: Record<string, string> = {
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION:
    "You are not allowed to invite users to this organization",
  ORGANIZATION_NOT_FOUND: "Organization not found",
  TEAM_NOT_FOUND: "Team not found",
  TEAM_MEMBER_LIMIT_REACHED: "Team member limit reached",
  INVITATION_NOT_FOUND: "Invitation not found",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "You are not the recipient of the invitation",
  // Ours: Better Auth has no team-level counterpart to
  // USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION.
  USER_IS_ALREADY_A_MEMBER_OF_THIS_TEAM:
    "User is already a member of this team",
};

const FORBIDDEN_CODES = new Set([
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
  "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
  "TEAM_MEMBER_LIMIT_REACHED",
]);

/**
 * Same envelope Better Auth returns — `{ message, code }`, and 403 for the
 * codes it answers 403 on — so the frontend branches on ONE set of codes
 * whichever path produced the error.
 */
const refuse = (code: string): never => {
  throw new APIError(FORBIDDEN_CODES.has(code) ? "FORBIDDEN" : "BAD_REQUEST", {
    message: ERROR_MESSAGES[code] ?? code,
    code,
  });
};

export const organizationTeamInvitationHooks = createAuthMiddleware(
  async (ctx) => {
    if (ctx.path === "/organization/invite-member") {
      const body = inviteMemberBodySchema.safeParse(ctx.body);
      if (!body.success) return undefined;

      const session = await getSessionFromCtx<
        Record<string, unknown>,
        OrganizationSessionFields
      >(ctx);
      // No session: the endpoint's own session middleware answers 401.
      if (!session) return undefined;

      const organizationId =
        body.data.organizationId ?? session.session.activeOrganizationId;
      if (!organizationId) return undefined;

      const result = await inviteMemberToTeam({
        organizationId,
        teamId: body.data.teamId,
        email: body.data.email,
        inviterUserId: session.user.id,
      });
      if (result.status === "not-a-member") return undefined;
      if (result.status === "refused") return refuse(result.reason);
      // Shaped like the plugin's own response: the invitation row.
      return ctx.json(result.invitation);
    }

    if (ctx.path === "/organization/accept-invitation") {
      const body = acceptInvitationBodySchema.safeParse(ctx.body);
      if (!body.success) return undefined;

      const session = await getSessionFromCtx(ctx);
      if (!session) return undefined;

      const result = await acceptTeamInvitationForMember({
        invitationId: body.data.invitationId,
        userId: session.user.id,
        userEmail: session.user.email,
      });
      if (result.status === "not-a-member") return undefined;
      if (result.status === "refused") return refuse(result.reason);
      return ctx.json({
        invitation: result.invitation,
        member: result.member,
      });
    }

    return undefined;
  },
);
