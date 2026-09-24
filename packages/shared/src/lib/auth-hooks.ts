import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { getOrgAdapter } from "better-auth/plugins/organization";
import { z } from "zod";

import { parseOrganizationRole } from "../authz/load-principal";
import { sendOrganizationInvitationEmail } from "../services/invitations/send-invitation-email";
import { MAX_MEMBERS_PER_TEAM, ORG_ADAPTER_OPTIONS } from "./auth-constants";
import {
  onGuestPromoted,
  onInvitationAccepted,
  onMembershipChanged,
} from "./auth-membership";

/**
 * Better Auth request hooks.
 *
 * The app invites through its own door (`POST /teams/{id}/invitations`,
 * `services/invitations/invite-to-team.ts`), decided by the organization's
 * policy rather than by organization roles. This hook keeps Better Auth's
 * endpoint correct for any client that still calls it.
 *
 * One job today: make "invite an existing organization member to one more
 * team" work. The organization plugin answers that request with
 * `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` — correct for an
 * organization invitation, wrong once `teams.enabled` makes a team a separate
 * grant — and its accept endpoint would write a SECOND `member` row for
 * someone who already has one (`createMember()` is unconditional, and `member`
 * has no unique index on `(organization_id, user_id)`).
 *
 * Both live inside the plugin's endpoints, out of reach of every option it
 * exposes: `organizationHooks.beforeCreateInvitation` runs AFTER the guard
 * that refuses, and `beforeAcceptInvitation` cannot stop the `createMember()`
 * that follows it. `addTeamMember` would add the member directly, but that is
 * a different product decision — no email, no consent, no accept step. A
 * `before` hook whose return value is not a `{ context }` patch short-circuits
 * the endpoint entirely, and is the one seam that sits in front of both.
 *
 * What it does NOT do is re-implement the plugin's data layer: every write
 * below goes through `getOrgAdapter`, the same adapter the endpoints use. That
 * is deliberate and load-bearing — `addTeamMemberWithLimit` owns the
 * `team_member` uniqueness key, the durable `team.member_count` that the seat
 * limit is enforced against, and the ordering that makes the two safe under
 * concurrency; `createInvitation` owns the expiry and the `teamIds` encoding;
 * `updateInvitation`'s `fromStatus` is a guarded, atomic transition. Hand-
 * rolling any of that means maintaining a second copy of semantics Better Auth
 * is free to change.
 *
 * The hook OWNS a request only when every one of these holds; anything else
 * returns `undefined` and the plugin's own handler runs untouched:
 *   - the path is one of the two endpoints below,
 *   - the body carries exactly the shape the team case needs,
 *   - there is a session,
 *   - the invited address already belongs to THIS organization (invite) / the
 *     caller already belongs to it (accept).
 *
 * That last condition is what keeps every ordinary invitation on the plugin's
 * code path: a person with no account, and — the case worth naming — a person
 * with a Fretik account in a DIFFERENT organization. Membership is per
 * organization, so they are not a member of this one, and joining it is
 * exactly the org-level invitation Better Auth already handles end to end.
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

      const adapter = getOrgAdapter(ctx.context, ORG_ADAPTER_OPTIONS);
      const email = body.data.email.trim().toLowerCase();

      // Not in this organization (no account, or an account that belongs to
      // another organization) → an ordinary invitation, and not ours.
      const invitee = await adapter.findMemberByEmail({
        email,
        organizationId,
      });
      if (!invitee) return undefined;

      // Same gate the plugin applies through `hasPermission({ invitation:
      // ["create"] })`: with no custom `roles` configured, its default
      // statements grant invitation creation to owner and admin only.
      const inviter = await adapter.findMemberByOrgId({
        userId: session.user.id,
        organizationId,
      });
      if (inviter?.role !== "owner" && inviter?.role !== "admin") {
        return refuse(
          "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
        );
      }

      // One read answers all three team questions: does it exist in this
      // organization, is the invitee already in it, and is there a seat left.
      const team = await adapter.findTeamById({
        teamId: body.data.teamId,
        organizationId,
        includeTeamMembers: true,
      });
      if (!team) return refuse("TEAM_NOT_FOUND");
      if (team.members.some((m) => m.userId === invitee.userId)) {
        return refuse("USER_IS_ALREADY_A_MEMBER_OF_THIS_TEAM");
      }
      // Refuse a seat the accept path would have to refuse anyway — better
      // here, where an admin is watching, than in the invitee's inbox tomorrow.
      if (team.members.length >= MAX_MEMBERS_PER_TEAM) {
        return refuse("TEAM_MEMBER_LIMIT_REACHED");
      }

      const organization = await adapter.findOrganizationById(organizationId);
      if (!organization) return refuse("ORGANIZATION_NOT_FOUND");

      // `cancelPendingInvitationsOnReInvite` cancels every pending invitation
      // for the address in the organization; scoped to the TEAM here on
      // purpose. Now that a member can hold invitations to several teams at
      // once, the org-wide sweep would silently drop a pending invitation to a
      // different team every time someone was invited to another one.
      const pending = await adapter.findPendingInvitation({
        email,
        organizationId,
      });
      await Promise.all(
        pending
          .filter((stale) => stale.teamId === body.data.teamId)
          .map((stale) =>
            adapter.updateInvitation({
              invitationId: stale.id,
              status: "canceled",
              fromStatus: "pending",
            }),
          ),
      );

      const invitation = await adapter.createInvitation({
        invitation: {
          email,
          // The role they ALREADY hold. A team invitation is not a role
          // change — accepting adds a `team_member` row and nothing else —
          // and recording anything else would put a promise in the pending
          // list that the accept path does not keep.
          role: invitee.role,
          organizationId,
          teamIds: [body.data.teamId],
        },
        user: session.user,
      });

      await sendOrganizationInvitationEmail({
        invitationId: invitation.id,
        email: invitation.email,
        inviterName: session.user.name,
        organizationName: organization.name,
        role: invitation.role,
        teamId: body.data.teamId,
        expiresAt: invitation.expiresAt,
        existingMember: true,
      });

      // Shaped like the plugin's own response: the invitation row.
      return ctx.json(invitation);
    }

    if (ctx.path === "/organization/accept-invitation") {
      const body = acceptInvitationBodySchema.safeParse(ctx.body);
      if (!body.success) return undefined;

      const session = await getSessionFromCtx(ctx);
      if (!session) return undefined;

      const adapter = getOrgAdapter(ctx.context, ORG_ADAPTER_OPTIONS);
      const invitation = await adapter.findInvitationById(
        body.data.invitationId,
      );
      // Unknown invitation → let the plugin answer INVITATION_NOT_FOUND.
      if (!invitation) return undefined;

      // Not a member of the inviting organization yet — including the person
      // who belongs to a DIFFERENT one. Joining is the ordinary accept, and
      // the plugin's `createMember()` is exactly what they need.
      const member = await adapter.findMemberByOrgId({
        userId: session.user.id,
        organizationId: invitation.organizationId,
      });
      if (!member) return undefined;

      // The same refusals the plugin makes, in the same order, so an expired
      // or misaddressed invitation answers identically either way.
      if (
        invitation.status !== "pending" ||
        invitation.expiresAt < new Date()
      ) {
        return refuse("INVITATION_NOT_FOUND");
      }
      if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
        return refuse("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION");
      }

      const accepted = await adapter.updateInvitation({
        invitationId: body.data.invitationId,
        status: "accepted",
        fromStatus: "pending",
      });
      // Guarded transition: a concurrent accept already took it.
      if (!accepted) return refuse("INVITATION_NOT_FOUND");

      // An organization-level invitation to someone already inside it grants
      // nothing; marking it accepted just stops it sitting in the pending list.
      //
      // Sequential on purpose (hence the `no-await-in-loop`): the multi-team
      // form is Better Auth's — this hook only ever writes one id — and if a
      // seat runs out the rest must NOT be granted, which is exactly what a
      // `Promise.all` would do before anyone could refuse.
      const teamIds = invitation.teamId ? invitation.teamId.split(",") : [];
      for (const teamId of teamIds) {
        const result = await adapter.addTeamMemberWithLimit({
          teamId,
          userId: session.user.id,
          maximumMembersPerTeam: MAX_MEMBERS_PER_TEAM,
        });
        if (result.status === "limitReached") {
          await adapter.updateInvitation({
            invitationId: body.data.invitationId,
            status: "pending",
            fromStatus: "accepted",
          });
          return refuse("TEAM_MEMBER_LIMIT_REACHED");
        }
      }

      // A guest invited to join as a member — an invitation sent before they
      // came in as a guest — becomes one: that is what it invites them to.
      // Nobody is ever moved DOWN by accepting: a member invited as a guest
      // stays a member.
      const invitedAs = parseOrganizationRole(invitation.role ?? "member");
      const promoted =
        parseOrganizationRole(member.role) === "guest" && invitedAs !== "guest"
          ? await adapter.updateMember(member.id, invitedAs)
          : null;

      // Written through the adapter, so no organization hook fired: the
      // cached principals learn of the new team here.
      await onMembershipChanged(invitation.organizationId);
      if (promoted) {
        await onGuestPromoted({
          organizationId: invitation.organizationId,
          userId: session.user.id,
          userName: session.user.name,
          role: invitedAs,
        });
      }
      // What the invitation was shared for becomes theirs.
      await onInvitationAccepted({
        organizationId: invitation.organizationId,
        invitationId: invitation.id,
        userId: session.user.id,
      });

      // The member row is returned as it stands — unchanged but for a
      // guest's promotion. Which team the invitee lands in is the client's
      // call (`app/pages/invitation.vue` switches to it after accepting);
      // their session already has an active organization and an active team,
      // and neither is the plugin's to reassign here.
      return ctx.json({ invitation: accepted, member: promoted ?? member });
    }

    return undefined;
  },
);
