import { and, eq, sql } from "drizzle-orm";
import { parseOrganizationRole } from "../../authz/load-principal";
import db from "../../db";
import { lastWorkspaces, member, team, teamMember } from "../../db/schema";

/**
 * Where each person last worked, so a new session opens there
 * (`last_workspaces`, wired to the sessions in `lib/auth-workspace.ts`).
 */

/** A workspace: an organization, and its team (none for a guest's access, or a member in no team yet). */
export interface WorkspaceAddress {
  organizationId: string;
  teamId: string | null;
}

/**
 * Remember where a session works. The row is written only when it changes: a
 * session is updated for other reasons too (its expiry slides as it is
 * used), and those leave the row as it was.
 */
export const rememberWorkspace = async (
  input: WorkspaceAddress & { userId: string },
): Promise<void> => {
  const { userId, organizationId, teamId } = input;
  await db
    .insert(lastWorkspaces)
    .values({ userId, organizationId, teamId })
    .onConflictDoUpdate({
      target: lastWorkspaces.userId,
      set: { organizationId, teamId, updatedAt: sql`now()` },
      setWhere: sql`${lastWorkspaces.organizationId} is distinct from excluded.organization_id or ${lastWorkspaces.teamId} is distinct from excluded.team_id`,
    });
};

/**
 * The workspace a new session opens: where the person last worked, as far as
 * they still belong there. The organization, while they are in it; its team,
 * while it is still theirs, else their only team there, else none, and the
 * app asks. A guest's access has no team, whatever a stray row says. Null
 * when there is nothing to reopen.
 */
export const workspaceToReopen = async (
  userId: string,
): Promise<WorkspaceAddress | null> => {
  const [last] = await db
    .select({
      organizationId: lastWorkspaces.organizationId,
      teamId: lastWorkspaces.teamId,
      role: member.role,
    })
    .from(lastWorkspaces)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, lastWorkspaces.organizationId),
        eq(member.userId, lastWorkspaces.userId),
      ),
    )
    .where(eq(lastWorkspaces.userId, userId))
    .limit(1);
  if (!last) return null;

  const role = parseOrganizationRole(last.role);
  // A team's agent never signs in; nothing of this is theirs.
  if (role === "bot") return null;
  if (role === "guest") {
    return { organizationId: last.organizationId, teamId: null };
  }

  const seats = await db
    .select({ teamId: teamMember.teamId })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(
      and(
        eq(teamMember.userId, userId),
        eq(team.organizationId, last.organizationId),
      ),
    );
  const theirs = seats.map((seat) => seat.teamId);
  const [only] = theirs;
  const teamId =
    last.teamId !== null && theirs.includes(last.teamId)
      ? last.teamId
      : theirs.length === 1 && only !== undefined
        ? only
        : null;
  return { organizationId: last.organizationId, teamId };
};

/** Forget where someone worked in an organization they have left. */
export const forgetWorkspace = async (input: {
  userId: string;
  organizationId: string;
}): Promise<void> => {
  await db
    .delete(lastWorkspaces)
    .where(
      and(
        eq(lastWorkspaces.userId, input.userId),
        eq(lastWorkspaces.organizationId, input.organizationId),
      ),
    );
};
