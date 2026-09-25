import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import type {
  OrganizationAccessPolicy,
  OrganizationAccessPolicyPatch,
} from "../../schemas/access-policy";
import { setOrganizationAccessPolicy } from "../organization/access-policy";

/**
 * Change what the organization allows beyond the roles: who creates teams,
 * who invites, whether public links exist… The admins decide
 * (`policies.manage`). Turning something off keeps what already exists and
 * stops what comes next (`schemas/access-policy.ts`).
 */
export const updateOrganizationPolicy = async (input: {
  principal: UserPrincipal;
  patch: OrganizationAccessPolicyPatch;
}): Promise<OrganizationAccessPolicy> => {
  const { principal } = input;
  await requireCapability({ principal, capability: "policies.manage" });
  return setOrganizationAccessPolicy({
    organizationId: principal.organizationId,
    patch: input.patch,
    actorUserId: principal.userId,
  });
};
