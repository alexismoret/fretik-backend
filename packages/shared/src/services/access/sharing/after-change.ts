import { bumpAccessVersion } from "../../../authz/load-principal";
import type { SharingResourceType } from "../../../schemas/access-sharing";

/**
 * What a change to who reaches a resource invalidates beyond the resource.
 *
 * Most resources are read fresh on every decision. A project is not only a
 * resource: who takes part in it is part of every principal of the
 * organization (`principal.projectLevels`, cached per access version), and
 * reaches everything the project holds. So a change to a project's members or
 * to its general access bumps that version — after it commits, so a reader
 * racing the write cannot refill the cache with the old answer.
 */
export const afterAccessChange = async (input: {
  organizationId: string;
  type: SharingResourceType;
}): Promise<void> => {
  if (input.type === "project") await bumpAccessVersion(input.organizationId);
};
