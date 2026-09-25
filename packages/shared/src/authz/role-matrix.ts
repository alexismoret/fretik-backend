import type { AccessStanding, RoleMatrixRow } from "../schemas/access-api";
import type { OrganizationAccessPolicy } from "../schemas/access-policy";
import {
  CAPABILITY_NAMES,
  capabilityPolicy,
  capabilityScope,
  decideCapability,
} from "./capabilities";
import type { UserPrincipal } from "./principal";

/**
 * The "Roles and permissions" grid: every capability, decided for each
 * standing a person can have, under the organization's policy as it stands.
 *
 * Computed by the same `decideCapability` that decides real requests, over
 * stand-in principals — so the page cannot describe a rule the engine does
 * not apply, nor miss one it does.
 */

/** The team every stand-in's team role is about. Never read from a database. */
const TEAM = "00000000-0000-7000-8000-000000000000";

const standIn = (standing: AccessStanding): UserPrincipal => {
  const base = {
    kind: "user" as const,
    userId: `stand-in-${standing}`,
    organizationId: "stand-in",
    teamContentLevels: new Map(),
    projectLevels: new Map(),
  };
  if (standing === "admin") {
    return {
      ...base,
      orgRole: "admin",
      isOrgAdmin: true,
      isGuest: false,
      teamRoles: new Map(),
    };
  }
  if (standing === "guest") {
    return {
      ...base,
      orgRole: "guest",
      isOrgAdmin: false,
      isGuest: true,
      teamRoles: new Map(),
    };
  }
  // A team role: an ordinary member of the organization, with that role in
  // the team the grid is about.
  return {
    ...base,
    orgRole: "member",
    isOrgAdmin: false,
    isGuest: false,
    teamRoles: new Map([[TEAM, standing]]),
  };
};

export const buildRoleMatrix = (
  policy: OrganizationAccessPolicy,
): RoleMatrixRow[] =>
  CAPABILITY_NAMES.map((capability) => {
    const decide = (standing: AccessStanding) =>
      decideCapability({
        principal: standIn(standing),
        capability,
        policy,
        teamId: TEAM,
      });
    return {
      capability,
      scope: capabilityScope(capability),
      policy: capabilityPolicy(capability),
      standings: {
        admin: decide("admin"),
        lead: decide("lead"),
        member: decide("member"),
        viewer: decide("viewer"),
        guest: decide("guest"),
      },
    };
  });
