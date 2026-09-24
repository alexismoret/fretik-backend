import type {
  CapabilityDecision,
  CapabilityKey,
  RequiredRole,
  TeamRole,
} from "../schemas/access";
import type {
  OrganizationAccessPolicy,
  PolicyAudience,
} from "../schemas/access-policy";
import type { Principal, UserPrincipal } from "./principal";

/**
 * Capabilities — what a person may do that is not about ONE resource: invite,
 * create a team, change a team's models, publish, share outside the team…
 *
 * Each is decided by two keys, like a bank vault: the person's role (in the
 * organization, or in the team the action is about) and, when the capability
 * has one, the organization's policy (`schemas/access-policy.ts`). The catalog
 * below is the single list; `GET /access/me` sends the decisions to the client
 * so it never recomputes them, and the "Roles and permissions" page is drawn
 * from it.
 *
 * Organization admins and owners count as LEADS of every team for the team
 * capabilities: managing a team's members and settings is structure. It gives
 * them nothing on content — that is the resource rules' business.
 */

export type { CapabilityDecision, RequiredRole };

/** Where a capability applies: the whole organization, or one team. */
export type CapabilityScope = "organization" | "team";

interface CapabilityDefinition {
  readonly scope: CapabilityScope;
  /**
   * The organization policy setting that moves this capability, when one
   * does — what the "Roles and permissions" grid links to.
   */
  readonly policy?: keyof OrganizationAccessPolicy;
  /** Decides, given the person's standing. */
  readonly decide: (standing: Standing) => CapabilityDecision;
}

/**
 * The person's standing where the capability applies: their organization role
 * and, for a team capability, their role in that team (admins as leads).
 */
interface Standing {
  readonly principal: UserPrincipal;
  readonly policy: OrganizationAccessPolicy;
  /** Null when the person is not in the team (and not an admin). */
  readonly teamRole: TeamRole | null;
}

const ALLOWED: CapabilityDecision = { allowed: true };

const refuse = (
  reason: "ROLE_REQUIRED" | "POLICY_DISABLED" | "GUEST_RESTRICTED",
  requiredRole: RequiredRole | null,
): CapabilityDecision => ({ allowed: false, reason, requiredRole });

const GUEST_REFUSED = refuse("GUEST_RESTRICTED", null);

/** Organization owners and admins only. */
const adminsOnly = (standing: Standing): CapabilityDecision => {
  if (standing.principal.isGuest) return GUEST_REFUSED;
  return standing.principal.isOrgAdmin
    ? ALLOWED
    : refuse("ROLE_REQUIRED", "admin");
};

/** Team leads (and admins, who lead every team). */
const teamLeadsOnly = (standing: Standing): CapabilityDecision => {
  if (standing.principal.isGuest) return GUEST_REFUSED;
  return standing.teamRole === "lead"
    ? ALLOWED
    : refuse("ROLE_REQUIRED", "lead");
};

/**
 * A team capability the policy extends down to `audience`. Viewers never get
 * one: a viewer reads. When the person's role WOULD be enough by default but
 * the policy narrowed the audience, the refusal says so (`POLICY_DISABLED`),
 * because the answer is then an admin's setting, not a promotion.
 */
const teamAudience =
  (
    audienceOf: (policy: OrganizationAccessPolicy) => PolicyAudience,
    defaultAudience: PolicyAudience,
  ) =>
  (standing: Standing): CapabilityDecision => {
    if (standing.principal.isGuest) return GUEST_REFUSED;
    const role = standing.teamRole;
    if (role === null) return refuse("ROLE_REQUIRED", "member");
    if (role === "viewer") return refuse("ROLE_REQUIRED", "member");
    const audience = audienceOf(standing.policy);
    if (reaches(audience, role, standing.principal)) return ALLOWED;
    const byDefault = reaches(defaultAudience, role, standing.principal);
    return refuse(
      byDefault ? "POLICY_DISABLED" : "ROLE_REQUIRED",
      audience === "admins" ? "admin" : "lead",
    );
  };

const reaches = (
  audience: PolicyAudience,
  teamRole: TeamRole,
  principal: UserPrincipal,
): boolean => {
  if (principal.isOrgAdmin) return true;
  switch (audience) {
    case "admins":
      return false;
    case "leads":
      return teamRole === "lead";
    case "members":
      return teamRole === "lead" || teamRole === "member";
  }
};

/** An organization capability governed by an on/off policy. */
const organizationSwitch =
  (enabled: (policy: OrganizationAccessPolicy) => boolean) =>
  (standing: Standing): CapabilityDecision => {
    if (standing.principal.isGuest) return GUEST_REFUSED;
    return enabled(standing.policy) ? ALLOWED : refuse("POLICY_DISABLED", null);
  };

export const CAPABILITIES = {
  // --- The organization -----------------------------------------------------
  /** Name, logo, sandbox network policy. */
  "organization.manage": { scope: "organization", decide: adminsOnly },
  /** Change organization roles, remove people from the organization. */
  "members.manage": { scope: "organization", decide: adminsOnly },
  /** Who may do what: the access policies. */
  "policies.manage": { scope: "organization", decide: adminsOnly },
  /** The access journal. */
  "audit.read": { scope: "organization", decide: adminsOnly },
  /** Answer capability requests and see every pending request. */
  "requests.review": { scope: "organization", decide: adminsOnly },
  /** Organization-wide collection templates and field definitions. */
  "organization.templates": { scope: "organization", decide: adminsOnly },
  /** See the organization's people and teams. Guests see their collaborators. */
  "directory.read": {
    scope: "organization",
    decide: (standing) =>
      standing.principal.isGuest ? GUEST_REFUSED : ALLOWED,
  },
  /** Create a team. */
  "teams.create": {
    scope: "organization",
    policy: "teamCreation",
    decide: (standing) => {
      if (standing.principal.isGuest) return GUEST_REFUSED;
      if (standing.principal.isOrgAdmin) return ALLOWED;
      return standing.policy.teamCreation === "members"
        ? ALLOWED
        : refuse("ROLE_REQUIRED", "admin");
    },
  },
  /** Share with the whole organization at once. */
  "share.organization": {
    scope: "organization",
    policy: "organizationSharing",
    decide: organizationSwitch((policy) => policy.organizationSharing),
  },
  /** Share with people or teams outside one's own team. */
  "share.cross_team": {
    scope: "organization",
    policy: "crossTeamSharing",
    decide: organizationSwitch((policy) => policy.crossTeamSharing),
  },

  // --- One team ---------------------------------------------------------------
  /** Rename the team, set its language. */
  "team.manage": { scope: "team", decide: teamLeadsOnly },
  /** Add and remove the team's members, set their team role. */
  "team.members.manage": { scope: "team", decide: teamLeadsOnly },
  /** The assistant's settings: models, tool permissions, skills. */
  "team.settings.manage": { scope: "team", decide: teamLeadsOnly },
  /** Clear the team's shared memory: hide its episodes, delete its notes in bulk. */
  "team.memory.manage": { scope: "team", decide: teamLeadsOnly },
  /** Invite people into the organization, into this team. */
  "members.invite": {
    scope: "team",
    policy: "memberInvitations",
    decide: teamAudience(
      (policy) => (policy.memberInvitations === "leads" ? "leads" : "admins"),
      "admins",
    ),
  },
  /** Invite a guest from outside onto something of this team. */
  "guests.invite": {
    scope: "team",
    policy: "guestInvitations",
    decide: teamAudience((policy) => policy.guestInvitations, "admins"),
  },
  /**
   * Contribute to the team's content: add files, pages, workflows, records
   * and collections, and change the ones this role may edit. A viewer reads —
   * and chats, which is not content of the team's.
   */
  "team.content.create": {
    scope: "team",
    decide: (standing) => {
      if (standing.principal.isGuest) return GUEST_REFUSED;
      const role = standing.teamRole;
      return role === "lead" || role === "member"
        ? ALLOWED
        : refuse("ROLE_REQUIRED", "member");
    },
  },
  /** Create a project in the team. */
  "projects.create": {
    scope: "team",
    policy: "projectCreation",
    decide: teamAudience((policy) => policy.projectCreation, "members"),
  },
  /** The team's instructions, files and memory for the assistant. */
  "team.context.edit": {
    scope: "team",
    policy: "teamContext",
    decide: teamAudience((policy) => policy.teamContext, "members"),
  },
  /** Connect, change and remove the team's shared apps. */
  "team.connections.manage": {
    scope: "team",
    policy: "teamConnections",
    decide: teamAudience((policy) => policy.teamConnections, "members"),
  },
  /** Let a workflow act without asking for approvals. */
  "team.workflows.autonomous": {
    scope: "team",
    policy: "autonomousWorkflows",
    decide: teamAudience((policy) => policy.autonomousWorkflows, "members"),
  },
  /** Publish a public link: a page on the web, a public form. */
  "share.public_link": {
    scope: "team",
    policy: "publicLinks",
    decide: (standing) => {
      if (standing.principal.isGuest) return GUEST_REFUSED;
      if (standing.policy.publicLinks === "nobody") {
        return refuse("POLICY_DISABLED", null);
      }
      return teamAudience(
        (policy) => (policy.publicLinks === "leads" ? "leads" : "members"),
        "members",
      )(standing);
    },
  },
} as const satisfies Record<CapabilityKey, CapabilityDefinition>;

export type Capability = CapabilityKey;

export { CAPABILITY_KEYS as CAPABILITY_NAMES } from "../schemas/access";

export const capabilityScope = (capability: Capability): CapabilityScope =>
  CAPABILITIES[capability].scope;

/** The policy setting that moves a capability, or null when none does. */
export const capabilityPolicy = (
  capability: Capability,
): keyof OrganizationAccessPolicy | null => {
  const definition: CapabilityDefinition = CAPABILITIES[capability];
  return definition.policy ?? null;
};

/**
 * Decide one capability. `teamId` is required for a team capability and
 * ignored otherwise. A system principal has every capability: it is the
 * caller that decided, in code, to act.
 */
export const decideCapability = (input: {
  principal: Principal;
  capability: Capability;
  policy: OrganizationAccessPolicy;
  teamId?: string | null;
}): CapabilityDecision => {
  const { principal, capability, policy } = input;
  if (principal.kind === "system") return ALLOWED;

  const definition: CapabilityDefinition = CAPABILITIES[capability];
  const teamRole =
    definition.scope === "team" ? teamRoleIn(principal, input.teamId) : null;
  return definition.decide({ principal, policy, teamRole });
};

/** The person's role in the team, admins counting as leads everywhere. */
const teamRoleIn = (
  principal: UserPrincipal,
  teamId: string | null | undefined,
): TeamRole | null => {
  if (principal.isOrgAdmin) return "lead";
  if (!teamId) return null;
  return principal.teamRoles.get(teamId) ?? null;
};
