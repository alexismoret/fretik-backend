import db from "../../db";
import { organizationSettings } from "../../db/schema";
import { redis, selectOrCache } from "../../lib/redis";
import {
  DEFAULT_ORGANIZATION_SANDBOX_POLICY,
  organizationSandboxPolicySchema,
  resolveSandboxPolicy,
  type OrganizationSandboxPolicy,
  type OrganizationSandboxPolicyPatch,
} from "../../schemas/sandbox-policy";

/**
 * The org's sandbox egress policy — read on every code-running turn, written
 * from one admin-only settings page.
 *
 * Cached under the `organization:{id}:` prefix that the Better Auth org hooks
 * already wipe, so the only invalidation this module owns is its own write.
 */

export const organizationSandboxPolicyCacheKey = (
  organizationId: string,
): string => `organization:${organizationId}:sandbox-policy`;

/**
 * Always a complete policy: an org with no settings row, a row written before
 * the column existed, or a value from an older shape all resolve to the
 * default rather than throwing. This sits on the turn path — failing here
 * would kill a turn over a settings read.
 */
export const getOrganizationSandboxPolicy = async (
  organizationId: string,
): Promise<OrganizationSandboxPolicy> =>
  selectOrCache(async () => {
    const row = await db.query.organizationSettings.findFirst({
      columns: { sandboxPolicy: true },
      where: { organizationId },
    });
    return resolveSandboxPolicy(row?.sandboxPolicy);
  }, organizationSandboxPolicyCacheKey(organizationId));

/**
 * Merge a partial policy into what is stored and return the result.
 *
 * Upserts, because `organization_settings` is a 1:1 extension row that is not
 * guaranteed to exist for an org created before it did — and an admin saving
 * a setting should not depend on that.
 */
export const setOrganizationSandboxPolicy = async (input: {
  organizationId: string;
  patch: OrganizationSandboxPolicyPatch;
}): Promise<OrganizationSandboxPolicy> => {
  const current = await db.query.organizationSettings.findFirst({
    columns: { sandboxPolicy: true },
    where: { organizationId: input.organizationId },
  });
  const merged = organizationSandboxPolicySchema.parse({
    ...resolveSandboxPolicy(current?.sandboxPolicy),
    ...input.patch,
  });

  await db
    .insert(organizationSettings)
    .values({ organizationId: input.organizationId, sandboxPolicy: merged })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { sandboxPolicy: merged },
    });

  // After the write, never before: a reader racing the update must not be
  // able to refill the cache with the old value.
  await redis.del(organizationSandboxPolicyCacheKey(input.organizationId));
  return merged;
};

export { DEFAULT_ORGANIZATION_SANDBOX_POLICY };
