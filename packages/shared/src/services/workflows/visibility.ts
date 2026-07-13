/**
 * Workflow visibility — a workflow is either team-shared (`userId` NULL) or
 * private to its owner (`userId` set). Mirrors the connection resolver's own
 * scope predicate (`services/external-apps/connections/resolve.ts`): a row is
 * visible when it's team-shared OR owned by the requester. Org admins/owners
 * see everything (governance), but ownership itself is never reassignable to
 * someone else — see the `userId` write-guard in `create.ts`/`update.ts`.
 *
 * `requester` is OPTIONAL and its absence means SYSTEM TRUST: internal
 * callers (cron-fire, the event sweep, the turn executor, run creation) never
 * pass one and see every workflow in the team, exactly like before this
 * feature existed. Only user-facing API/tool callers pass a requester.
 */
export interface WorkflowRequester {
  userId: string;
  isAdmin: boolean;
}

/** Spread into a Drizzle relational `where` alongside other filters. */
export const workflowVisibilityWhere = (requester?: WorkflowRequester) =>
  !requester || requester.isAdmin
    ? {}
    : {
        OR: [
          { userId: { isNull: true as const } },
          { userId: requester.userId },
        ],
      };

/**
 * Write-time ownership guard shared by `createWorkflow`/`updateWorkflow`: the
 * only values ever written to `workflows.userId` are `null` (team-shared) or
 * the acting user's own id (private to themselves) — never another user's id,
 * which would silently make a run impersonate someone else. Returns an error
 * message, or null when the value is allowed.
 */
export const workflowOwnerWriteError = (
  userId: string | null | undefined,
  actingUserId: string,
): string | null => {
  if (userId === undefined || userId === null) return null;
  if (userId === actingUserId) return null;
  return "workflow.userId can only be null (team-shared) or your own id (private to you) — a workflow can't be scoped to another user.";
};
