import { z } from "@hono/zod-openapi";
import {
  accessLevelSchema,
  assignableOrganizationRoleSchema,
  organizationRoleSchema,
  teamRoleSchema,
} from "./access";
import { sharingResourceTypeSchema } from "./access-sharing";

/**
 * The organization's people and its pending invitations, as the Members page
 * and a team's page show them.
 *
 * The team agents' service accounts (`bot`) are members of the organization
 * for the engine and never people here: they are neither listed, counted,
 * given a role nor invited.
 */

/** Every role a listed person can hold: all of them but the agents'. */
export const personRoleSchema = organizationRoleSchema.exclude(["bot"]);

export const memberTeamSchema = z
  .object({
    teamId: z.uuid(),
    name: z.string(),
    role: teamRoleSchema,
  })
  .openapi("MemberTeam");

export const organizationMemberSchema = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: personRoleSchema,
    joinedAt: z.date(),
    /** The teams they are in, with their role in each, by team name. */
    teams: z.array(memberTeamSchema),
  })
  .openapi("OrganizationMember");
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

export const organizationMembersSchema = z
  .object({ members: z.array(organizationMemberSchema) })
  .openapi("OrganizationMembers");

export const setOrganizationRoleSchema = z
  .object({ role: assignableOrganizationRoleSchema })
  .openapi("SetOrganizationRole");

export const memberParamsSchema = z.object({
  userId: z.uuid().openapi({ param: { name: "userId", in: "path" } }),
});

// --- Invitations ------------------------------------------------------------

/** An item shared with someone still invited: what accepting gives them. */
export const invitationItemSchema = z
  .object({
    type: sharingResourceTypeSchema,
    id: z.uuid(),
    name: z.string(),
    level: accessLevelSchema,
  })
  .openapi("InvitationItem");
export type InvitationItem = z.infer<typeof invitationItemSchema>;

export const pendingInvitationSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    /** The organization role they will hold once they accept. */
    role: personRoleSchema,
    teamId: z.uuid().nullable(),
    teamName: z.string().nullable(),
    inviterName: z.string().nullable(),
    expiresAt: z.date(),
    createdAt: z.date(),
    /**
     * What was shared with them by email, waiting for their yes — all a
     * guest's invitation gives; for a future member, what comes with the team.
     */
    items: z.array(invitationItemSchema),
  })
  .openapi("PendingInvitation");
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;

export const pendingInvitationsSchema = z
  .object({ invitations: z.array(pendingInvitationSchema) })
  .openapi("PendingInvitations");

/** One screen of addresses at a time, like adding people to a team. */
export const MAX_INVITATIONS_PER_REQUEST = 20;

export const inviteToTeamSchema = z
  .object({
    invitations: z
      .array(
        z.object({
          email: z.email().max(320),
          /**
           * Their role in the ORGANIZATION if they are new to it. Someone
           * already in it keeps the one they have: joining a team is not a
           * role change.
           */
          role: assignableOrganizationRoleSchema.default("member"),
        }),
      )
      .min(1)
      .max(MAX_INVITATIONS_PER_REQUEST),
  })
  .openapi("InviteToTeam");

/**
 * What became of one address:
 *
 *   invited          an invitation is on its way (a new one replaces any
 *                    pending one to the same team, so this is also "resend")
 *   already_in_team  they are in the team already; nothing was sent
 *   failed           the email could not be sent; the invitation was withdrawn
 *                    with it, so sending again is safe
 *
 * A full team refuses the whole request instead (409): an invitation takes no
 * seat until it is accepted, so every address would meet the same answer.
 */
export const INVITATION_OUTCOMES = [
  "invited",
  "already_in_team",
  "failed",
] as const;
export type InvitationOutcomeStatus = (typeof INVITATION_OUTCOMES)[number];

export const invitationOutcomeSchema = z
  .object({
    email: z.string(),
    status: z.enum(INVITATION_OUTCOMES),
    invitationId: z.uuid().nullable(),
  })
  .openapi("InvitationOutcome");
export type InvitationOutcome = z.infer<typeof invitationOutcomeSchema>;

export const invitationOutcomesSchema = z
  .object({ outcomes: z.array(invitationOutcomeSchema) })
  .openapi("InvitationOutcomes");

export const teamInvitationParamsSchema = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
  invitationId: z
    .uuid()
    .openapi({ param: { name: "invitationId", in: "path" } }),
});
