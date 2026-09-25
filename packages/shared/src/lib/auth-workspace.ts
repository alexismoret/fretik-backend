import {
  rememberWorkspace,
  workspaceToReopen,
} from "../services/workspaces/last-workspace";

/**
 * Where a session works, carried from one session to the next.
 *
 * Better Auth opens every session with no organization, and our sessions live
 * in Redis alone: once one ends, nothing says where its person worked. So:
 *
 *   - every update of a session remembers its workspace (`session.update.after`).
 *     That is every door that moves one: switching a team or an organization,
 *     accepting an invitation, creating an organization. A session's expiry
 *     also slides as it is used, which rewrites nothing unless the place
 *     changed: with two sessions open in two places, the one used last is the
 *     one remembered;
 *   - a new session opens where the last one was (`session.create.before`),
 *     checked against today's memberships (`services/workspaces/last-workspace.ts`).
 *     The app then goes straight there, and asks only when nothing is left to
 *     reopen.
 *
 * Both are best-effort: a sign-in never fails over where it opens, nor a
 * switch over being remembered.
 */

/** A session field as Better Auth keeps it: an id, or nothing. */
const idOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** What a new session opens on: the last workspace, unless the sign-in already chose one. */
export const openLastWorkspace = async (session: {
  userId: string;
  activeOrganizationId?: unknown;
}): Promise<
  | { data: { activeOrganizationId: string; activeTeamId: string | null } }
  | undefined
> => {
  if (idOf(session.activeOrganizationId) !== null) return undefined;
  try {
    const last = await workspaceToReopen(session.userId);
    if (last === null) return undefined;
    return {
      data: {
        activeOrganizationId: last.organizationId,
        activeTeamId: last.teamId,
      },
    };
  } catch (err) {
    console.warn("[workspace] could not reopen the last workspace:", err);
    return undefined;
  }
};

/** Remember where a session now works. */
export const rememberSessionWorkspace = async (
  session: Record<string, unknown> | null,
): Promise<void> => {
  const userId = idOf(session?.userId);
  const organizationId = idOf(session?.activeOrganizationId);
  // No workspace open (it left the one it had): the last one stays.
  if (userId === null || organizationId === null) return;
  try {
    await rememberWorkspace({
      userId,
      organizationId,
      teamId: idOf(session?.activeTeamId),
    });
  } catch (err) {
    console.warn("[workspace] could not remember the workspace:", err);
  }
};
