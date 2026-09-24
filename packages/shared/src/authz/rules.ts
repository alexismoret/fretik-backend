import type { AccessLevel, AccessResourceType } from "../schemas/access";
import { atLeast, capLevel, maxLevel } from "./levels";
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

/** The most a node of this type gives through inheritance, when less than full. */
export const inheritedCap = (type: AccessResourceType): AccessLevel | null =>
  INHERITED_CAP[type] ?? null;

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
 * The most a node gives this person, whatever is shared with them: a
 * type-specific ceiling that depends on the node itself. A refusal above it
 * offers nothing to request (`refusals.ts`), since no share would lift it.
 *
 * A restricted workflow runs WITH ITS OWNER'S ACCESS — their connections,
 * their private files. Anyone else who could run or edit it would act as
 * them, so for everyone but the owner it can be shown, never run or changed.
 * To work on it together, it is opened to the team, and then it runs as the
 * team's agent.
 *
 * Taking part in a chat is for the people who work where it lives: the
 * assistant answers there in that place's context (its instructions, its
 * memory, its connections), which a seat would lend to anyone else. A chat in
 * a project is for the people who take part in the project (`use`), whatever
 * their team; any other chat, for the people of its team. Whoever else
 * reaches the chat, because it was given to them or because they have left
 * since, reads it.
 */
export const levelCeiling = (
  principal: UserPrincipal,
  node: ResourceNode,
): AccessLevel =>
  ceilingFor(node, {
    isOwner: node.ownerUserId === principal.userId,
    worksThere: worksWhere(principal, node),
  });

/**
 * Whether the person works where the node lives: in its project, taking part
 * in it, when it has one; else in its team, whatever their role there.
 */
export const worksWhere = (
  principal: UserPrincipal,
  node: ResourceNode,
): boolean =>
  node.projectId !== null
    ? atLeast(principal.projectLevels.get(node.projectId) ?? null, "use")
    : node.teamId !== null && principal.teamRoles.has(node.teamId);

/**
 * `levelCeiling` from the two facts it reads about the person — whether they
 * own the node, whether they work where it lives — so the share dialog can
 * say what a kind of person may be given before anyone is picked.
 */
export const ceilingFor = (
  node: ResourceNode,
  person: { readonly isOwner: boolean; readonly worksThere: boolean },
): AccessLevel => {
  if (node.type === "workflow" && node.restricted && !person.isOwner) {
    return "view";
  }
  if (
    node.type === "conversation" &&
    node.teamId !== null &&
    !person.worksThere
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
  return capLevel(level, levelCeiling(principal, node));
};
