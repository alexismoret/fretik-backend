import { eq } from "drizzle-orm";
import { bumpAccessVersion } from "../../authz/load-principal";
import db from "../../db";
import { organizationSettings, teamSettings } from "../../db/schema";
import { redis, selectOrCache } from "../../lib/redis";
import {
  DEFAULT_ORGANIZATION_ACCESS_POLICY,
  DEFAULT_TEAM_ACCESS_POLICY,
  type OrganizationAccessPolicy,
  organizationAccessPolicyOverrides,
  type OrganizationAccessPolicyPatch,
  organizationAccessPolicySchema,
  resolveOrganizationAccessPolicy,
  resolveTeamAccessPolicy,
  type TeamAccessPolicy,
  teamAccessPolicyOverrides,
  type TeamAccessPolicyPatch,
  teamAccessPolicySchema,
} from "../../schemas/access-policy";
import { recordAccessEvent } from "../access/record-event";

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

/** What one change did to each setting it touched, for the journal. */
const changedSettings = <T extends Record<string, unknown>>(
  before: T,
  after: T,
): { setting: string; from: unknown; to: unknown }[] =>
  Object.keys(after)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ setting: key, from: before[key], to: after[key] }));

/**
 * Apply an administrator's change. What is STORED is only what they set
 * (`organizationAccessPolicyOverrides`), never the resolved policy: a default
 * that changes in a later release then still reaches every organization that
 * never touched that setting, instead of being frozen into its row the first
 * time anyone saved anything.
 *
 * The journal entry commits with the policy; who may make the change is the
 * caller's to decide (`policies.manage`).
 */
export const setOrganizationAccessPolicy = async (input: {
  organizationId: string;
  patch: OrganizationAccessPolicyPatch;
  actorUserId: string;
}): Promise<OrganizationAccessPolicy> => {
  const resolved = await db.transaction(async (tx) => {
    const current = await tx.query.organizationSettings.findFirst({
      columns: { accessPolicy: true },
      where: { organizationId: input.organizationId },
    });
    const overrides = {
      ...organizationAccessPolicyOverrides(current?.accessPolicy),
      ...input.patch,
    };
    // Refuses an invalid value rather than storing it: reads are forgiving,
    // writes are not.
    const after = organizationAccessPolicySchema.parse({
      ...DEFAULT_ORGANIZATION_ACCESS_POLICY,
      ...overrides,
    });
    const changes = changedSettings(
      resolveOrganizationAccessPolicy(current?.accessPolicy),
      after,
    );
    if (changes.length === 0) return after;

    await tx
      .insert(organizationSettings)
      .values({ organizationId: input.organizationId, accessPolicy: overrides })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { accessPolicy: overrides },
      });
    await recordAccessEvent({
      executor: tx,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "organization_policy.updated",
      metadata: { changes },
    });
    return after;
  });

  // After the commit, never before: a reader racing the update must not be
  // able to refill the cache with the old value.
  await redis.del(organizationAccessPolicyCacheKey(input.organizationId));
  return resolved;
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
 * version. Sparse, like the organization's: only what a lead set is stored.
 */
export const setTeamAccessPolicy = async (input: {
  teamId: string;
  organizationId: string;
  patch: TeamAccessPolicyPatch;
  actorUserId: string;
  /** The team's name as it reads in the journal. */
  teamName: string;
}): Promise<TeamAccessPolicy> => {
  const { resolved, changed } = await db.transaction(async (tx) => {
    const current = await tx.query.teamSettings.findFirst({
      columns: { accessPolicy: true },
      where: { teamId: input.teamId },
    });
    const overrides = {
      ...teamAccessPolicyOverrides(current?.accessPolicy),
      ...input.patch,
    };
    const after = teamAccessPolicySchema.parse({
      ...DEFAULT_TEAM_ACCESS_POLICY,
      ...overrides,
    });
    const changes = changedSettings(
      resolveTeamAccessPolicy(current?.accessPolicy),
      after,
    );
    if (changes.length === 0) return { resolved: after, changed: false };

    await tx
      .update(teamSettings)
      .set({ accessPolicy: overrides })
      .where(eq(teamSettings.teamId, input.teamId));
    await recordAccessEvent({
      executor: tx,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "team_policy.updated",
      principal: { type: "team", id: input.teamId },
      metadata: { teamName: input.teamName, changes },
    });
    return { resolved: after, changed: true };
  });

  if (changed) {
    await redis.del(teamAccessPolicyCacheKey(input.teamId));
    await bumpAccessVersion(input.organizationId);
  }
  return resolved;
};
