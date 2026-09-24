import type { AccessLevel, AccessResourceType } from "../schemas/access";
import { capLevel, maxLevel } from "./levels";
import {
  type GrantFact,
  levelFromGrants,
  projectContentLevel,
  projectLevelForTeamRole,
  type UserPrincipal,
} from "./principal";

/**
 * THE access rules, as one pure function.
 *
 * Everything that decides a level lives here, and nothing here reads a
 * database: the resource adapters (`resources/`) load a node's facts, the
 * principal loader loads the person, and this file says what they add up to.
 * That is what makes the rules testable as a table (`tests/unit/authz-rules`)
 * and what the SQL list filters (`resources/sql.ts`) are checked against.
 *
 * The model, in the order the paths are tried — the HIGHEST wins, there is no
 * deny rule:
 *
 *   1. the owner has full access;
 *   2. explicit grants to the person, their teams, their projects or the
 *      whole organization (`levelFromGrants`);
 *   3. unless the node is RESTRICTED, what it inherits: from the folder it
 *      sits in, else from its container — its project when it has one, else
 *      its team.
 *
 * A restricted node stops at step 3: only its owner and its grants reach it.
 * An organization's admins get nothing here by their role — they run the
 * structure (capabilities), they do not read people's private work.
 */

export interface ResourceNode {
  readonly type: AccessResourceType;
  readonly id: string;
  readonly organizationId: string;
  /** The team that holds it. Null only for an organization-level collection. */
  readonly teamId: string | null;
  /** The project that holds it, when one does. */
  readonly projectId: string | null;
  readonly ownerUserId: string | null;
  /** Restricted: it inherits nothing, only its owner and its grants reach it. */
  readonly restricted: boolean;
  readonly grants: readonly GrantFact[];
  /** The folder it inherits from, for Drive items inside a folder. */
  readonly parent: ResourceNode | null;
}

/**
 * The most a node gives through INHERITANCE, per type. A conversation opened
 * to its team or project can be read by everyone there, but taking part in it
 * is a seat someone gives (`ai_conversation_members`): inheriting stops at
 * `view`.
 */
const INHERITED_CAP: Partial<Record<AccessResourceType, AccessLevel>> = {
  conversation: "view",
};

/** What the container gives: the project's level when it has one, else the team's. */
const containerLevel = (
  principal: UserPrincipal,
  node: ResourceNode,
): AccessLevel | null => {
  if (node.type === "project") {
    // A project's own container is its team, read through the project mapping
    // (a member takes part and edits; deleting a project is a lead's call).
    const role =
      node.teamId === null ? undefined : principal.teamRoles.get(node.teamId);
    return role === undefined ? null : projectLevelForTeamRole(role);
  }
  if (node.projectId !== null) {
    return projectContentLevel(
      principal.projectLevels.get(node.projectId) ?? null,
    );
  }
  if (node.teamId === null) return null;
  return principal.teamContentLevels.get(node.teamId) ?? null;
};

const inheritedLevel = (
  principal: UserPrincipal,
  node: ResourceNode,
): AccessLevel | null => {
  if (node.restricted) return null;
  const inherited =
    node.parent === null
      ? containerLevel(principal, node)
      : computeLevel(principal, node.parent);
  return capLevel(inherited, INHERITED_CAP[node.type] ?? "full");
};

/**
 * Type-specific ceilings that depend on the node itself.
 *
 * A restricted workflow runs WITH ITS OWNER'S ACCESS — their connections,
 * their private files. Anyone else who could run or edit it would act as
 * them, so for everyone but the owner it can be shown, never run or changed.
 * To work on it together, it is opened to the team, and then it runs as the
 * team's agent.
 */
const nodeCeiling = (
  principal: UserPrincipal,
  node: ResourceNode,
): AccessLevel => {
  if (
    node.type === "workflow" &&
    node.restricted &&
    node.ownerUserId !== principal.userId
  ) {
    return "view";
  }
  return "full";
};

/** The person's effective level on the node, or null when they cannot see it. */
export const computeLevel = (
  principal: UserPrincipal,
  node: ResourceNode,
): AccessLevel | null => {
  if (node.organizationId !== principal.organizationId) return null;

  const level = maxLevel(
    node.ownerUserId === principal.userId ? "full" : null,
    levelFromGrants(principal, node.grants),
    inheritedLevel(principal, node),
  );
  return capLevel(level, nodeCeiling(principal, node));
};
