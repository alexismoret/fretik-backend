import type { AccessLevel } from "../schemas/access";
import type { OrganizationAccessPolicy } from "../schemas/access-policy";
import { levelRank } from "./levels";
import { ceilingFor, type ResourceNode } from "./rules";

/**
 * Guests — people from outside the organization, who see only what is shared
 * with them (a client on their project, a partner on one document).
 *
 * The engine needs no rule of its own for them: a guest belongs to no team and
 * is never part of "everyone in the organization" (`principal.ts`), so every
 * level they hold comes from a grant to them — on an item, or on a project
 * they take part in. What is special is what they may be GIVEN, and every
 * door that gives a guest access applies the terms below: sharing
 * (`services/access/sharing/share.ts`), a level change, an invitation by email
 * (`services/access/guests/`) and its acceptance.
 */

/**
 * The most a guest is given on what is not theirs. Full access is sharing,
 * moving and deleting — the organization's calls, never an outsider's; a
 * guest keeps full access to what they create themselves (a chat, a file in
 * their project), as every owner does.
 */
export const GUEST_LEVEL_CEILING: AccessLevel = "edit";

const lower = (a: AccessLevel, b: AccessLevel): AccessLevel =>
  levelRank(a) <= levelRank(b) ? a : b;

/**
 * What a guest may be given on a node: what anyone who does not work where it
 * lives may hold (`ceilingFor` — a chat is read, not taken part in), and
 * never beyond `GUEST_LEVEL_CEILING`. A guest who takes part in the node's
 * project works there, and may take part in its chats (`worksThere`).
 */
export const guestCeilingFor = (
  node: ResourceNode,
  worksThere = false,
): AccessLevel =>
  lower(ceilingFor(node, { isOwner: false, worksThere }), GUEST_LEVEL_CEILING);

/**
 * When access given to a guest today ends, by the organization's policy; null
 * when it lasts until someone removes it. Giving the access again starts a
 * new period.
 */
export const guestAccessExpiry = (
  policy: OrganizationAccessPolicy,
  now: Date = new Date(),
): Date | null =>
  policy.guestAccessDays === null
    ? null
    : new Date(now.getTime() + policy.guestAccessDays * 24 * 60 * 60 * 1000);
