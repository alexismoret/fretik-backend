import type {
  AccessLevel,
  OrganizationRole,
  TeamRole,
} from "../schemas/access";
import type { TeamAccessPolicy } from "../schemas/access-policy";
import { atLeast, capLevel, maxLevel } from "./levels";

/**
 * WHO is asking — the input of every access decision.
 *
 * A principal is loaded once per request (`load-principal.ts`, cached per
 * organization version) and carries everything the rules need about the
 * person, so a decision is a pure function of (principal, resource). What it
 * does NOT carry is anything about a resource: those facts are read per
 * resource, next to the rows.
 */

export interface UserPrincipal {
  readonly kind: "user";
  readonly userId: string;
  readonly organizationId: string;
  readonly orgRole: OrganizationRole;
  /** Owner or admin: runs the structure, never reads private work by role. */
  readonly isOrgAdmin: boolean;
  /** From outside the organization: sees only what is shared with them. */
  readonly isGuest: boolean;
  /** The teams the person belongs to, with their role in each. */
  readonly teamRoles: ReadonlyMap<string, TeamRole>;
  /** What the person gets on each of those teams' own content. */
  readonly teamContentLevels: ReadonlyMap<string, AccessLevel>;
  /** Every project the person reaches, with their level on the project. */
  readonly projectLevels: ReadonlyMap<string, AccessLevel>;
}

/**
 * A call with no person behind it — the cron, the event sweep, the document
 * pipeline. It is never implied: a service that receives no principal refuses,
 * and a system caller says so, with a reason a reviewer can read.
 */
export interface SystemPrincipal {
  readonly kind: "system";
  readonly reason: string;
}

export type Principal = UserPrincipal | SystemPrincipal;

export const systemPrincipal = (reason: string): SystemPrincipal => ({
  kind: "system",
  reason,
});

export const isUserPrincipal = (
  principal: Principal,
): principal is UserPrincipal => principal.kind === "user";

/**
 * What a team role gives on the team's own content. A lead has everything; a
 * member what the team's policy says (`full` by default — what everyone had
 * before roles); a viewer reads.
 */
export const teamContentLevelForRole = (
  role: TeamRole,
  policy: TeamAccessPolicy,
): AccessLevel => {
  switch (role) {
    case "lead":
      return "full";
    case "member":
      return policy.memberContentLevel;
    case "viewer":
      return "view";
  }
};

/**
 * What a team role gives on the team's projects that are open to the team.
 * Narrower than on team content on purpose: `full` on a project is its
 * membership, its settings and its deletion — with everything inside it — so
 * it stays with leads and with the project's owner and full members.
 */
export const projectLevelForTeamRole = (role: TeamRole): AccessLevel => {
  switch (role) {
    case "lead":
      return "full";
    case "member":
      return "edit";
    case "viewer":
      return "view";
  }
};

/**
 * What a level on a project gives on the content it holds, when that content
 * is open to the project. `use` on a project means "take part": work there,
 * with one's own chats and files — and read what others share, not change it.
 */
export const projectContentLevel = (
  projectLevel: AccessLevel | null,
): AccessLevel | null => (projectLevel === "use" ? "view" : projectLevel);

/** A grant as the rules read it: who it is for, and what it gives. */
export interface GrantFact {
  readonly principalType: "user" | "team" | "project" | "organization";
  readonly principalId: string;
  readonly level: AccessLevel;
  /**
   * A chat's seat (`ai_conversation_members`): its owner's, or taking part,
   * given to someone who works where the chat lives. A guest keeps it only
   * while they do (`rules.ts`).
   */
  readonly seat?: true;
}

/**
 * The projects the person takes part in (`use` or more): where they work,
 * whichever team holds them.
 */
export const projectsTakenPartIn = (principal: UserPrincipal): string[] =>
  [...principal.projectLevels]
    .filter(([, level]) => atLeast(level, "use"))
    .map(([projectId]) => projectId);

/**
 * The level a set of grants gives this person. A grant to a group is capped by
 * the person's place in it: a team VIEWER reads whatever the team was given,
 * and so does someone who only views or takes part in a project.
 */
export const levelFromGrants = (
  principal: UserPrincipal,
  grants: readonly GrantFact[],
): AccessLevel | null => {
  let best: AccessLevel | null = null;
  for (const grant of grants) {
    best = maxLevel(best, levelFromGrant(principal, grant));
  }
  return best;
};

const levelFromGrant = (
  principal: UserPrincipal,
  grant: GrantFact,
): AccessLevel | null => {
  switch (grant.principalType) {
    case "user":
      return grant.principalId === principal.userId ? grant.level : null;
    case "team": {
      const role = principal.teamRoles.get(grant.principalId);
      if (role === undefined) return null;
      return role === "viewer" ? capLevel(grant.level, "view") : grant.level;
    }
    case "project": {
      const projectLevel = principal.projectLevels.get(grant.principalId);
      if (projectLevel === undefined) return null;
      return projectLevel === "view" || projectLevel === "use"
        ? capLevel(grant.level, "view")
        : grant.level;
    }
    case "organization":
      return grant.principalId === principal.organizationId &&
        !principal.isGuest
        ? grant.level
        : null;
  }
};
