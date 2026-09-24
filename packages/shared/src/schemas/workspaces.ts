import { z } from "@hono/zod-openapi";
import { invitationItemSchema, personRoleSchema } from "./members";

/**
 * Where a person can work, across every organization they belong to, and
 * the invitations still waiting for their answer (`GET /workspaces`). The
 * app's workspace switcher and its setup page read it, before any
 * organization is open.
 *
 * What the switcher offers follows from each membership: a member works in
 * one of their teams, a guest in the organization itself, where they see
 * what is shared with them and belong to no team.
 */

export const workspaceOrganizationSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable(),
  })
  .openapi("WorkspaceOrganization");

export const workspaceTeamSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
  })
  .openapi("WorkspaceTeam");

export const workspaceMembershipSchema = z
  .object({
    organization: workspaceOrganizationSchema,
    /** Their role in it; a `guest` is in no team. */
    role: personRoleSchema,
    /** The teams they belong to in it, by name. */
    teams: z.array(workspaceTeamSchema),
  })
  .openapi("WorkspaceMembership");
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

export const invitationToMeSchema = z
  .object({
    id: z.uuid(),
    organization: workspaceOrganizationSchema.omit({ slug: true }),
    inviter: z.object({ name: z.string(), image: z.string().nullable() }),
    /** The role accepting brings, unless they already hold a higher one. */
    role: personRoleSchema,
    /** The team it opens, if any. */
    team: workspaceTeamSchema.nullable(),
    /** What was shared with them by email, which accepting gives. */
    items: z.array(invitationItemSchema),
    expiresAt: z.date(),
    /** They already belong to the organization: it opens one more team. */
    alreadyMember: z.boolean(),
  })
  .openapi("InvitationToMe");
export type InvitationToMe = z.infer<typeof invitationToMeSchema>;

export const workspacesSchema = z
  .object({
    memberships: z.array(workspaceMembershipSchema),
    invitations: z.array(invitationToMeSchema),
  })
  .openapi("Workspaces");
export type Workspaces = z.infer<typeof workspacesSchema>;
