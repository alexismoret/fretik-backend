import { z } from "@hono/zod-openapi";
import {
  capabilityDecisionSchema,
  capabilityKeySchema,
  teamRoleSchema,
} from "./access";
import { teamAccessPolicySchema } from "./access-policy";

/**
 * Teams, as the settings pages and the team switcher see them.
 *
 * A team's ROLES live beside Better Auth's `team_member` rows
 * (`team_member_roles`): lead, member, viewer. The per-team agent user is
 * never listed nor counted — it backs the assistant, it is not a person.
 */

export const TEAM_NAME_MAX = 80;

const teamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TEAM_NAME_MAX)
  .openapi({ example: "Operations" });

export const teamSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** People in the team; the team's agent is not one. */
    memberCount: z.number().int().nonnegative(),
    /** The caller's role in it; null when they are not in it. */
    role: teamRoleSchema.nullable(),
    createdAt: z.date(),
  })
  .openapi("TeamSummary");
export type TeamSummary = z.infer<typeof teamSummarySchema>;

export const teamMemberEntrySchema = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: teamRoleSchema,
    joinedAt: z.date().nullable(),
  })
  .openapi("TeamMemberEntry");
export type TeamMemberEntry = z.infer<typeof teamMemberEntrySchema>;

export const teamDetailSchema = teamSummarySchema
  .extend({
    members: z.array(teamMemberEntrySchema),
    /** The team's access defaults (what a member gets on its content). */
    policy: teamAccessPolicySchema,
    /**
     * What the caller may do IN THIS TEAM, decided by the engine — so the
     * page shows, hides or locks each action without re-deriving a rule.
     */
    capabilities: z.record(capabilityKeySchema, capabilityDecisionSchema),
  })
  .openapi("TeamDetail");
export type TeamDetail = z.infer<typeof teamDetailSchema>;

export const createTeamSchema = z
  .object({ name: teamNameSchema })
  .openapi("CreateTeam");

export const renameTeamSchema = z
  .object({ name: teamNameSchema })
  .openapi("RenameTeam");

/** At most one screen of people at a time: the picker's own ceiling. */
export const MAX_TEAM_MEMBERS_PER_ADD = 50;

export const addTeamMembersSchema = z
  .object({
    userIds: z.array(z.uuid()).min(1).max(MAX_TEAM_MEMBERS_PER_ADD),
    role: teamRoleSchema.default("member"),
  })
  .openapi("AddTeamMembers");

export const setTeamMemberRoleSchema = z
  .object({ role: teamRoleSchema })
  .openapi("SetTeamMemberRole");

export const teamRosterSchema = z
  .object({ members: z.array(teamMemberEntrySchema) })
  .openapi("TeamRoster");

export const teamsListSchema = z
  .object({ teams: z.array(teamSummarySchema) })
  .openapi("Teams");

export const teamMemberParamsSchema = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
  userId: z.uuid().openapi({ param: { name: "userId", in: "path" } }),
});
