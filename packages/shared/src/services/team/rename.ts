import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import { teamRowCacheKey } from "../../lib/auth-roles";
import { organizationAdapter } from "../../lib/org-adapter";
import { redis } from "../../lib/redis";
import { recordAccessEvent } from "../access/record-event";
import { findOrganizationTeam } from "./find";

/** Rename a team: its leads' call, and the organization's admins' (`team.manage`). */
export const renameTeam = async (input: {
  principal: UserPrincipal;
  teamId: string;
  name: string;
}): Promise<void> => {
  const { principal } = input;
  const found = await findOrganizationTeam(principal, input.teamId);
  await requireCapability({
    principal,
    capability: "team.manage",
    teamId: found.id,
  });
  if (found.name === input.name) return;

  const adapter = await organizationAdapter();
  await adapter.updateTeam(found.id, { name: input.name });
  // Every session with this team active reads the row from the cache.
  await redis.del(teamRowCacheKey(found.id));
  await recordAccessEvent({
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    action: "team.renamed",
    principal: { type: "team", id: found.id },
    metadata: { from: found.name, to: input.name },
  });
};
