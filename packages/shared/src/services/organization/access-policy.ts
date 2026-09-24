import { eq } from "drizzle-orm";
import { bumpAccessVersion } from "../../authz/load-principal";
import db from "../../db";
import { organizationSettings, teamSettings } from "../../db/schema";
import { redis, selectOrCache } from "../../lib/redis";
import {
  type OrganizationAccessPolicy,
  type OrganizationAccessPolicyPatch,
  organizationAccessPolicySchema,
  resolveOrganizationAccessPolicy,
  resolveTeamAccessPolicy,
  type TeamAccessPolicy,
  type TeamAccessPolicyPatch,
  teamAccessPolicySchema,
} from "../../schemas/access-policy";

/**
 * The access policies — read on every capability decision, written from the
 * "Security and sharing" settings and a team's access defaults.
 *
 * Same shape as the sandbox policy (`sandbox-policy.ts`): cached under the
 * organization's (or team's) prefix, always resolved to a complete policy so a
 * missing row or an old shape falls back to the defaults instead of failing a
 * request, and upserted because the 1:1 settings row is not guaranteed to
 * exist for an organization or a team created before it did.
 */

export const organizationAccessPolicyCacheKey = (
  organizationId: string,
): string => `organization:${organizationId}:access-policy`;

export const teamAccessPolicyCacheKey = (teamId: string): string =>
  `team:${teamId}:access-policy`;

export const getOrganizationAccessPolicy = async (
  organizationId: string,
): Promise<OrganizationAccessPolicy> =>
  selectOrCache(async () => {
    const row = await db.query.organizationSettings.findFirst({
      columns: { accessPolicy: true },
      where: { organizationId },
    });
    return resolveOrganizationAccessPolicy(row?.accessPolicy);
  }, organizationAccessPolicyCacheKey(organizationId));

export const setOrganizationAccessPolicy = async (input: {
  organizationId: string;
  patch: OrganizationAccessPolicyPatch;
}): Promise<OrganizationAccessPolicy> => {
  const current = await db.query.organizationSettings.findFirst({
    columns: { accessPolicy: true },
    where: { organizationId: input.organizationId },
  });
  const merged = organizationAccessPolicySchema.parse({
    ...resolveOrganizationAccessPolicy(current?.accessPolicy),
    ...input.patch,
  });

  await db
    .insert(organizationSettings)
    .values({ organizationId: input.organizationId, accessPolicy: merged })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { accessPolicy: merged },
    });

  // After the write, never before: a reader racing the update must not be
  // able to refill the cache with the old value.
  await redis.del(organizationAccessPolicyCacheKey(input.organizationId));
  return merged;
};

export const getTeamAccessPolicy = async (
  teamId: string,
): Promise<TeamAccessPolicy> =>
  selectOrCache(async () => {
    const row = await db.query.teamSettings.findFirst({
      columns: { accessPolicy: true },
      where: { teamId },
    });
    return resolveTeamAccessPolicy(row?.accessPolicy);
  }, teamAccessPolicyCacheKey(teamId));

/**
 * The team row always exists here (`afterCreateTeam` writes it with the bot
 * user it needs), so this updates rather than upserts: an insert would have to
 * invent a bot user.
 *
 * A team's policy is part of what its members' principals hold (the level
 * they get on its content), so changing it bumps the organization's access
 * version.
 */
export const setTeamAccessPolicy = async (input: {
  teamId: string;
  organizationId: string;
  patch: TeamAccessPolicyPatch;
}): Promise<TeamAccessPolicy> => {
  const current = await getTeamAccessPolicy(input.teamId);
  const merged = teamAccessPolicySchema.parse({ ...current, ...input.patch });
  await db
    .update(teamSettings)
    .set({ accessPolicy: merged })
    .where(eq(teamSettings.teamId, input.teamId));
  await redis.del(teamAccessPolicyCacheKey(input.teamId));
  await bumpAccessVersion(input.organizationId);
  return merged;
};
