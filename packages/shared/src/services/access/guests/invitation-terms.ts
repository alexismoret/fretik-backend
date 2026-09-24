import { and, eq, gt } from "drizzle-orm";
import { levelRank } from "../../../authz/levels";
import { parseOrganizationRole } from "../../../authz/load-principal";
import type { LoadedNode } from "../../../authz/resources/types";
import { ceilingFor } from "../../../authz/rules";
import type { Executor } from "../../../db";
import { invitation } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import type { AccessLevel, OrganizationRole } from "../../../schemas/access";
import { ERROR_CODES } from "../../../schemas/errors";
import { assertGuestLevel, type Newcomer } from "../sharing/share";

/**
 * What an address still invited may be given, before it has an account to
 * give it to. The invitation's role decides: a guest's invitation is held to
 * a guest's terms (`authz/guests.ts`); a future member's, to what a member of
 * the teams it joins may hold — and to the organization's policy on sharing
 * beyond one's team, like any member.
 */

/** A pending invitation, as the terms read it. */
export interface InvitationFacts {
  readonly id: string;
  readonly email: string;
  readonly role: OrganizationRole;
  /** The teams it joins; none for a guest's. */
  readonly teamIds: readonly string[];
  readonly expiresAt: Date;
}

/** A pending, unexpired invitation of the organization; null otherwise. */
export const findPendingInvitation = async (
  executor: Executor,
  organizationId: string,
  invitationId: string,
): Promise<InvitationFacts | null> => {
  const [row] = await executor
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      teamId: invitation.teamId,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.id, invitationId),
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
  return row ? toFacts(row) : null;
};

/** An invitation row as the terms read it. */
export const toFacts = (row: {
  id: string;
  email: string;
  role: string | null;
  teamId?: string | null;
  expiresAt: Date;
}): InvitationFacts => ({
  id: row.id,
  email: row.email.toLowerCase(),
  // No role is Better Auth's default: a member.
  role: parseOrganizationRole(row.role ?? "member"),
  // Better Auth stores a multi-team invitation as a joined list.
  teamIds: row.teamId?.split(",") ?? [],
  expiresAt: row.expiresAt,
});

/** The invitation as the sharing policy sees a newcomer. */
export const invitationNewcomer = (facts: {
  readonly role: OrganizationRole;
  readonly teamIds: readonly string[];
}): Newcomer => {
  const guest = facts.role === "guest";
  return {
    type: "invitation",
    teamIds: new Set(guest ? [] : facts.teamIds),
    guest,
    inProject: false,
  };
};

/**
 * Refuse a level the invitation's person could not hold once in: beyond a
 * guest's ceiling, or — for a future member — taking part in a chat outside
 * the teams they join (nobody is a project's participant before joining).
 */
export const assertInvitationLevel = (
  node: LoadedNode,
  level: AccessLevel,
  facts: {
    readonly email: string;
    readonly role: OrganizationRole;
    readonly teamIds: readonly string[];
  },
): void => {
  if (facts.role === "guest") {
    assertGuestLevel(node, level, facts.email);
    return;
  }
  const worksThere =
    node.projectId === null &&
    node.teamId !== null &&
    facts.teamIds.includes(node.teamId);
  const ceiling = ceilingFor(node, { isOwner: false, worksThere });
  if (levelRank(level) <= levelRank(ceiling)) return;
  throwHttpError(400, {
    code: ERROR_CODES.PARTICIPANT_OUTSIDE_TEAM,
    message: `${facts.email} can be given at most ${ceiling} access here until they join.`,
  });
};
