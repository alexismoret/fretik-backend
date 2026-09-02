import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setConnectionPreference } from "../../../src/services/external-apps/connections/preference";
import { resolvePageConnection } from "../../../src/services/external-apps/connections/resolve-for-page";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * `resolvePageConnection` — which account a page dataset runs against.
 *
 * The rule it enforces is a privacy rule, not a convenience: a shared page must
 * never spend a colleague's credentials on another viewer's screen. That rule
 * lives entirely in one `where` clause — the OR between "team-scoped" and "mine"
 * — and until 2026-09-02 that clause had no test at all. The suite faked `db`,
 * and the fake's `findMany` returned the fixture list whatever the `where` said,
 * so the visibility tests asserted that the FAKE had filtered. Deleting the OR
 * from the service left every one of them green.
 *
 * Three tests here used to assert on the recorded `where` object instead of on
 * an outcome ("the where pins userId to IS NULL", "the where says acme-mail").
 * Against a real database they can say the thing that actually matters: an
 * anonymous viewer does not get a colleague's account, and a page that spells
 * the key the Python way still finds the row.
 *
 * Each test claims its own `providerKey`, so the shared workspace cannot leak
 * one test's connections into another's candidate list under `--randomize`.
 */

let fx: WorkspaceFixture;
let viewer: string;
let colleague: string;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [viewer, colleague] = fx.userIds;
});

afterAll(async () => {
  await fx.cleanup();
});

let counter = 0;
const nextKey = (): string => {
  counter += 1;
  return `acme-mail-${counter.toString()}`;
};

describe("pinned connectionId", () => {
  test("missing row is an error, not a prompt — the page names something gone", async () => {
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      connectionId: "00000000-0000-4000-8000-00000000dead",
    });
    expect(result.status).toBe("error");
  });

  test("a pin on ANOTHER team's connection is gone, not borrowed", async () => {
    // The pin is looked up by `{ id, teamId }`. The old fake's `findFirst`
    // ignored both, so dropping `teamId` from the query changed nothing there
    // and would let a page pin — and spend — another workspace's account.
    const other = await createWorkspaceFixture();
    try {
      const theirs = await other.createConnection({ providerKey: nextKey() });
      const result = await resolvePageConnection({
        teamId: fx.teamId,
        userId: viewer,
        connectionId: theirs.id,
      });
      expect(result.status).toBe("error");
    } finally {
      await other.cleanup();
    }
  });

  test("someone else's personal connection resolves to needs_connection, never their account", async () => {
    const providerKey = nextKey();
    const theirs = await fx.createConnection({
      providerKey,
      userId: colleague,
    });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      connectionId: theirs.id,
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey,
      displayName: "Integration app",
      reason: "pinned_to_another_user",
      candidates: [],
    });
  });

  test("a non-active pinned connection is an error that names its state", async () => {
    const broken = await fx.createConnection({
      providerKey: nextKey(),
      status: "disabled",
    });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      connectionId: broken.id,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("disabled");
    }
  });

  test("a team-shared pin resolves for any viewer; an own personal pin too", async () => {
    const shared = await fx.createConnection({ providerKey: nextKey() });
    expect(
      (
        await resolvePageConnection({
          teamId: fx.teamId,
          userId: viewer,
          connectionId: shared.id,
        })
      ).status,
    ).toBe("ok");

    const mine = await fx.createConnection({
      providerKey: nextKey(),
      userId: viewer,
    });
    expect(
      (
        await resolvePageConnection({
          teamId: fx.teamId,
          userId: viewer,
          connectionId: mine.id,
        })
      ).status,
    ).toBe("ok");
  });
});

describe("providerKey resolution — personal first, team second", () => {
  test("the viewer's personal connection beats the team's shared one", async () => {
    const providerKey = nextKey();
    await fx.createConnection({ providerKey });
    const mine = await fx.createConnection({ providerKey, userId: viewer });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.connection.id).toBe(mine.id);
  });

  test("a COLLEAGUE's personal connection is invisible — it is not a candidate at all", async () => {
    // The privacy rule, stated as an outcome. Nothing in the old suite could
    // express it: the fake handed back whatever the test had put in the list.
    const providerKey = nextKey();
    await fx.createConnection({ providerKey, userId: colleague });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey,
      reason: "none",
      candidates: [],
    });
  });

  test("no personal connection falls back to the team's", async () => {
    const providerKey = nextKey();
    const shared = await fx.createConnection({ providerKey });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe(shared.id);
      expect(result.chosenBy).toBe("team");
    }
  });

  test("another team's connection for the same app is not a candidate", async () => {
    const providerKey = nextKey();
    const other = await createWorkspaceFixture();
    try {
      await other.createConnection({ providerKey });
      const result = await resolvePageConnection({
        teamId: fx.teamId,
        userId: viewer,
        providerKey,
      });
      expect(result.status).toBe("needs_connection");
    } finally {
      await other.cleanup();
    }
  });

  test("no connection at all is the connect prompt, and says nobody has one", async () => {
    const providerKey = nextKey();
    expect(
      await resolvePageConnection({
        teamId: fx.teamId,
        userId: viewer,
        providerKey,
      }),
    ).toEqual({
      status: "needs_connection",
      providerKey,
      reason: "none",
      candidates: [],
    });
  });

  test("a connection that exists but cannot be used is a DIFFERENT no", async () => {
    // "Connect your account" is the wrong instruction when the account is
    // there and broken — connecting a second one fixes nothing. This is the
    // distinction a user got stuck on.
    const providerKey = nextKey();
    const broken = await fx.createConnection({ providerKey, status: "error" });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey,
      reason: "unusable",
      candidates: [
        {
          id: broken.id,
          displayName: "Integration app",
          scope: "team",
          status: "error",
        },
      ],
    });
  });

  test("two candidates in one tier resolve deterministically instead of failing", async () => {
    // This used to return an error telling the reader to "pin one with
    // connectionId" — advice for the page's AUTHOR, shown to a viewer who
    // cannot act on it, in place of the data. Pick the most recent, and let
    // the panel offer the switch.
    const providerKey = nextKey();
    await fx.createConnection({
      providerKey,
      userId: viewer,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const newer = await fx.createConnection({
      providerKey,
      userId: viewer,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const resolvedTie = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
    });
    expect(resolvedTie.status).toBe("ok");
    if (resolvedTie.status === "ok") {
      expect(resolvedTie.connection.id).toBe(newer.id);
      expect(resolvedTie.candidates).toHaveLength(2);
    }
  });

  test("an anonymous viewer gets the team tier only — never a member's account", async () => {
    const providerKey = nextKey();
    await fx.createConnection({ providerKey, userId: viewer });
    const anonymous = await resolvePageConnection({
      teamId: fx.teamId,
      userId: null,
      providerKey,
    });
    expect(anonymous).toEqual({
      status: "needs_connection",
      providerKey,
      reason: "none",
      candidates: [],
    });

    const shared = await fx.createConnection({ providerKey });
    const withTeamTier = await resolvePageConnection({
      teamId: fx.teamId,
      userId: null,
      providerKey,
    });
    expect(withTeamTier.status).toBe("ok");
    if (withTeamTier.status === "ok") {
      expect(withTeamTier.connection.id).toBe(shared.id);
    }
  });

  test("neither pin nor provider is a definition defect", async () => {
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
    });
    expect(result.status).toBe("error");
  });
});

/**
 * A stored definition is the one place a provider key is TYPED, and the agent
 * types the Python module's name. Folding it here is what repairs a page nobody
 * reopens — the measured failure (2026-08-26) was a page permanently prompting
 * every viewer to connect an app the team had connected all along.
 */
describe("providerKey is folded onto the spelling a row can carry", () => {
  test("the snake_case module name finds the kebab-case row", async () => {
    const providerKey = nextKey();
    const shared = await fx.createConnection({ providerKey });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey: providerKey.replace(/-/g, "_"),
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.connection.id).toBe(shared.id);
  });

  test("upper case folds too", async () => {
    const providerKey = nextKey();
    const shared = await fx.createConnection({ providerKey });
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey: providerKey.toUpperCase(),
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.connection.id).toBe(shared.id);
  });

  test("the connect prompt names the FOLDED key, not what the page wrote", async () => {
    const providerKey = nextKey();
    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey: providerKey.replace(/-/g, "_"),
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey,
      reason: "none",
      candidates: [],
    });
  });
});

/**
 * The viewer's own choice, which exists because the automatic pick was a coin
 * toss they could not overrule.
 */
describe("a stored preference, and where it stops", () => {
  test("it beats the tier rule — 'the team's, not mine, on this page'", async () => {
    const providerKey = nextKey();
    const shared = await fx.createConnection({ providerKey });
    await fx.createConnection({ providerKey, userId: viewer });
    const page = await fx.createPage();
    await setConnectionPreference({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
      pageId: page.id,
      connectionId: shared.id,
    });

    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
      pageId: page.id,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe(shared.id);
      expect(result.chosenBy).toBe("viewer_preference");
    }
  });

  test("a preference pointing at something unusable falls through, never fails", async () => {
    const providerKey = nextKey();
    const broken = await fx.createConnection({ providerKey, status: "error" });
    const mine = await fx.createConnection({ providerKey, userId: viewer });
    const page = await fx.createPage();
    await setConnectionPreference({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
      pageId: page.id,
      connectionId: broken.id,
    });

    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
      pageId: page.id,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe(mine.id);
      expect(result.chosenBy).toBe("personal");
    }
  });

  test("a colleague's preference is not this viewer's", async () => {
    const providerKey = nextKey();
    const shared = await fx.createConnection({ providerKey });
    const mine = await fx.createConnection({ providerKey, userId: viewer });
    const page = await fx.createPage();
    await setConnectionPreference({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: colleague,
      providerKey,
      pageId: page.id,
      connectionId: shared.id,
    });

    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
      pageId: page.id,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe(mine.id);
      expect(result.chosenBy).toBe("personal");
    }
  });

  test("the author's pin still wins — a pin means EVERYONE uses that account", async () => {
    const providerKey = nextKey();
    const pinned = await fx.createConnection({ providerKey });
    const mine = await fx.createConnection({ providerKey, userId: viewer });
    const page = await fx.createPage();
    await setConnectionPreference({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: viewer,
      providerKey,
      pageId: page.id,
      connectionId: mine.id,
    });

    const result = await resolvePageConnection({
      teamId: fx.teamId,
      userId: viewer,
      connectionId: pinned.id,
      pageId: page.id,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe(pinned.id);
      expect(result.chosenBy).toBe("author_pin");
    }
  });
});
