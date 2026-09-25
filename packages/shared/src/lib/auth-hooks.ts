import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { getOrgAdapter } from "better-auth/plugins/organization";
import { z } from "zod";

import { parseOrganizationRole } from "../authz/load-principal";
import { MAX_MEMBERS_PER_TEAM, ORG_ADAPTER_OPTIONS } from "./auth-constants";
import {
  onGuestPromoted,
  onInvitationAccepted,
  onMembershipChanged,
} from "./auth-membership";
import { refuseReplacedEndpoint } from "./auth-replaced-endpoints";

/**
 * Better Auth's `before` hooks: what runs in front of its endpoints.
 *
 *   - The endpoints that change who belongs where are closed: Fretik's own
 *     routes replace them, with the organization's policies and the journal
 *     (`auth-replaced-endpoints.ts`).
 *   - Accepting a team invitation as someone already in the organization.
 *
 * The organization plugin's accept endpoint ends in an unconditional
 * `createMember()`: for someone already in the organization, invited to one
 * more team (`services/invitations/invite-to-team.ts`), it would write a
 * SECOND `member` row, and `organizationHooks.beforeAcceptInvitation` cannot
 * stop what follows it. A `before` hook whose return value is not a
 * `{ context }` patch short-circuits the endpoint entirely, and is the one
 * seam in front of it.
 *
 * What it does NOT do is re-implement the plugin's data layer: every write
 * below goes through `getOrgAdapter`, the same adapter the endpoints use. That
 * is deliberate and load-bearing: `addTeamMemberWithLimit` owns the
 * `team_member` uniqueness key, the durable `team.member_count` that the seat
 * limit is enforced against, and the ordering that makes the two safe under
 * concurrency; `updateInvitation`'s `fromStatus` is a guarded, atomic
 * transition. Hand-rolling any of that means maintaining a second copy of
 * semantics Better Auth is free to change.
 *
 * The hook OWNS an accept only when the caller already belongs to the
 * inviting organization. Anyone else (a person with no account, or with an
 * account in a DIFFERENT organization) is joining it, which is the
 * invitation Better Auth handles end to end: the hook returns `undefined`
 * and the plugin's own handler runs untouched.
 */

const acceptInvitationBodySchema = z.object({
  invitationId: z.string().min(1),
});

/** Messages mirroring Better Auth's ORGANIZATION_ERROR_CODES, which the plugin does not export. */
const ERROR_MESSAGES: Record<string, string> = {
  TEAM_MEMBER_LIMIT_REACHED: "Team member limit reached",
  INVITATION_NOT_FOUND: "Invitation not found",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "You are not the recipient of the invitation",
};

const FORBIDDEN_CODES = new Set([
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

export const organizationBeforeHooks = createAuthMiddleware(async (ctx) => {
  refuseReplacedEndpoint(ctx.path);

  if (ctx.path === "/organization/accept-invitation") {
    const body = acceptInvitationBodySchema.safeParse(ctx.body);
    if (!body.success) return undefined;

    const session = await getSessionFromCtx(ctx);
    if (!session) return undefined;

    const adapter = getOrgAdapter(ctx.context, ORG_ADAPTER_OPTIONS);
    const invitation = await adapter.findInvitationById(body.data.invitationId);
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
    if (invitation.status !== "pending" || invitation.expiresAt < new Date()) {
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
});
