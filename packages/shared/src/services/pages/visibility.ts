/**
 * Page visibility — a page is either team-shared (`userId` NULL) or private to
 * its owner (`userId` set). Same shape and same doctrine as
 * `services/workflows/visibility.ts`: a row is visible when it's team-shared
 * OR owned by the requester; org admins see everything (governance), and
 * ownership is never reassignable to someone else.
 *
 * `requester` is OPTIONAL and its absence means SYSTEM TRUST: internal callers
 * (the public-page resolver, which has already authorised through the token)
 * pass none and see every page in the team. Only user-facing API/tool callers
 * pass a requester.
 */
export interface PageRequester {
  userId: string;
  isAdmin: boolean;
}

/** Spread into a Drizzle relational `where` alongside other filters. */
export const pageVisibilityWhere = (requester?: PageRequester) =>
  !requester || requester.isAdmin
    ? {}
    : {
        OR: [
          { userId: { isNull: true as const } },
          { userId: requester.userId },
        ],
      };

/**
 * Write-time ownership guard shared by `createPage`/`updatePage`: the only
 * values ever written to `pages.userId` are `null` (team-shared) or the acting
 * user's own id (private to themselves) — never another user's.
 */
export const pageOwnerWriteError = (
  userId: string | null | undefined,
  actingUserId: string,
): string | null => {
  if (userId === undefined || userId === null) return null;
  if (userId === actingUserId) return null;
  return "page.userId can only be null (team-shared) or your own id (private to you) — a page can't be scoped to another user.";
};
