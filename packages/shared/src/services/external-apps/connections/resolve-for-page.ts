import db from "../../../db";
import { type ExternalAppConnection } from "../../../db/schema";
import { canonicalProviderKey } from "../../../external-apps/canonical-provider-key";
import { preferredConnectionId } from "./preference";

/**
 * Resolve the connection a PAGE dataset or operation runs against — the page
 * sibling of `resolveConnection`, different on purpose in three ways:
 *
 * 1. It never throws HTTP errors. A page degrades per dataset, so every
 *    outcome is a value the caller renders — including "this viewer just has
 *    to connect their account", which is a prompt, not a failure.
 * 2. It PREFERS the viewer's own connection over the team's shared one when
 *    the dataset names a provider (`resolveConnection` treats the two tiers as
 *    one pool and calls two candidates ambiguous). Same page, each member's
 *    own data — the whole point of resolving at view time.
 * 3. A PINNED connection that is user-scoped to someone else resolves to
 *    `needs_connection`, never to that person's account: a shared page must
 *    not spend a colleague's credentials on another viewer's screen.
 *
 * It also reports WHY. A bare `needs_connection` reads as "you are not
 * connected" whatever the real reason — and a user hit exactly that: the team's
 * connection was there all along, the banner said to connect one, and nothing
 * on screen could tell the two situations apart. `candidates` and `reason`
 * carry the difference up to the banner and the sources panel.
 */

/** What the viewer needs to know about one connection they could be using. */
export interface PageConnectionCandidate {
  id: string;
  displayName: string;
  scope: "team" | "user";
  status: ExternalAppConnection["status"];
}

/** Why no connection was used, in terms the UI can act on. */
export type PageConnectionReason =
  /** Nobody on the team has connected this app. */
  | "none"
  /** A connection exists but is disabled or in error — an admin must fix it. */
  | "unusable"
  /** The page pins a colleague's personal account; this viewer needs their own. */
  | "pinned_to_another_user";

export type PageConnectionResolution =
  | {
      status: "ok";
      connection: ExternalAppConnection;
      /** Why this one: the author's pin, the viewer's choice, or the fallback. */
      chosenBy: "author_pin" | "viewer_preference" | "personal" | "team";
      /** Every connection the viewer could have used, when there was a choice. */
      candidates: PageConnectionCandidate[];
    }
  | {
      status: "needs_connection";
      providerKey: string;
      displayName?: string;
      reason: PageConnectionReason;
      candidates: PageConnectionCandidate[];
    }
  | { status: "error"; message: string };

const toCandidate = (row: ExternalAppConnection): PageConnectionCandidate => ({
  id: row.id,
  displayName: row.displayName,
  scope: row.userId === null ? "team" : "user",
  status: row.status,
});

export const resolvePageConnection = async (params: {
  teamId: string;
  /** The viewer; null on the anonymous route (only a team pin could pass). */
  userId: string | null;
  connectionId?: string;
  providerKey?: string;
  /**
   * The page being viewed, when there is one. Only used to look up this
   * viewer's stored choice for it — a dry run or an anonymous render passes
   * nothing and simply gets the automatic pick.
   */
  pageId?: string;
}): Promise<PageConnectionResolution> => {
  if (params.connectionId !== undefined) {
    const row = await db.query.externalAppConnections.findFirst({
      where: { id: params.connectionId, teamId: params.teamId },
    });
    if (row === undefined) {
      return {
        status: "error",
        message: "the pinned connection no longer exists on this team",
      };
    }
    if (row.userId !== null && row.userId !== params.userId) {
      // Someone else's personal connection — the viewer needs their own.
      return {
        status: "needs_connection",
        providerKey: row.providerKey,
        displayName: row.displayName,
        reason: "pinned_to_another_user",
        candidates: [],
      };
    }
    if (row.status !== "active") {
      return {
        status: "error",
        message: `connection "${row.displayName}" is ${row.status} — fix it under Settings → Connected apps`,
      };
    }
    return {
      status: "ok",
      connection: row,
      chosenBy: "author_pin",
      candidates: [],
    };
  }

  if (params.providerKey === undefined) {
    return {
      status: "error",
      message: "a connection needs providerKey or a pinned connectionId",
    };
  }

  // Folded, not trusted as written: a stored definition may spell the key the
  // way the Python module does (`akanea_wms`), and that page would otherwise
  // prompt every viewer to connect an app the team is already connected to,
  // forever. Repairs the page nobody reopens; `sanitizePageDefinition` fixes
  // the stored spelling on its next write.
  const providerKey = canonicalProviderKey(params.providerKey);

  // Every status, not just `active`: a connection in error is the difference
  // between "connect this app" and "someone has to reconnect it", and the
  // viewer cannot act on the second by connecting a second account.
  const visible = await db.query.externalAppConnections.findMany({
    where: {
      providerKey,
      teamId: params.teamId,
      // No viewer (anonymous) → only the team tier may match; an empty-string
      // uuid comparison would not "not match", it would fail the query.
      ...(params.userId === null
        ? { userId: { isNull: true } }
        : { OR: [{ userId: { isNull: true } }, { userId: params.userId }] }),
    },
  });
  const candidates = visible.map(toCandidate);
  const usable = visible.filter((row) => row.status === "active");

  // The viewer's own choice, ahead of any automatic rule but behind the
  // author's pin. Only consulted when it can still be honoured: a preference
  // pointing at a connection that was deleted, disabled or made personal to
  // someone else falls through to the normal pick rather than failing the
  // dataset — the row is a shortcut, never a constraint.
  if (params.userId !== null) {
    const preferred = await preferredConnectionId({
      teamId: params.teamId,
      userId: params.userId,
      providerKey,
      ...(params.pageId !== undefined ? { pageId: params.pageId } : {}),
    });
    const match = usable.find((row) => row.id === preferred);
    if (match !== undefined) {
      return {
        status: "ok",
        connection: match,
        chosenBy: "viewer_preference",
        candidates,
      };
    }
  }

  const personal = usable.filter(
    (row) => row.userId !== null && row.userId === params.userId,
  );
  const shared = usable.filter((row) => row.userId === null);
  const tier = personal.length > 0 ? personal : shared;

  const [first] = tier;
  if (first === undefined) {
    // The FOLDED key: what the viewer is told to connect must be the app the
    // resolver actually looked for, not the spelling the definition used.
    return {
      status: "needs_connection",
      providerKey,
      reason: visible.length > 0 ? "unusable" : "none",
      candidates,
    };
  }
  // Two in the same tier used to be a hard error saying "pin one with
  // connectionId" — advice addressed to the page's author, handed to a viewer
  // who cannot act on it and shown instead of the data. Pick the most recent
  // deterministically, say so, and let the panel offer the switch.
  const chosen =
    tier.length === 1
      ? first
      : [...tier].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )[0];
  if (chosen === undefined) {
    return {
      status: "needs_connection",
      providerKey,
      reason: "none",
      candidates,
    };
  }
  return {
    status: "ok",
    connection: chosen,
    chosenBy: chosen.userId === null ? "team" : "personal",
    candidates,
  };
};
