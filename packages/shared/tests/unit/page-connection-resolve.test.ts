import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "./mock-module";

/**
 * `resolvePageConnection` — the page-side connection resolver. Its whole
 * reason to exist over `resolveConnection`: prefer the viewer's PERSONAL
 * connection over the team's shared one, never throw (a page degrades per
 * dataset), and never resolve to a colleague's personal account.
 *
 * The db is mocked at module level; each test sets what the queries return.
 * Tier preference operates on the returned candidates, which is exactly what
 * these tests exercise — the SQL predicates are Drizzle's business.
 */

interface Row {
  id: string;
  providerKey: string;
  displayName: string;
  teamId: string;
  userId: string | null;
  status: string;
  createdAt: Date;
}

let pinned: Row | undefined;
let candidates: Row[] = [];
/** The acting viewer's stored choice, when a test sets one. */
let preference: { connectionId: string; pageId: string | null } | undefined;
const findManyWheres: Record<string, unknown>[] = [];

await mockModule("../../src/db", {
  default: {
    query: {
      externalAppConnections: {
        findFirst: () => Promise.resolve(pinned),
        findMany: (args: { where?: Record<string, unknown> }) => {
          findManyWheres.push(args.where ?? {});
          return Promise.resolve(candidates);
        },
      },
      externalAppConnectionPreferences: {
        findMany: () => Promise.resolve(preference ? [preference] : []),
      },
    },
  },
});

const { resolvePageConnection } =
  await import("../../src/services/external-apps/connections/resolve-for-page");

const row = (extra: Partial<Row>): Row => ({
  id: "conn-1",
  providerKey: "acme-mail",
  displayName: "Acme Mail",
  teamId: "team-1",
  userId: null,
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...extra,
});

beforeEach(() => {
  pinned = undefined;
  candidates = [];
  preference = undefined;
  findManyWheres.length = 0;
});

describe("pinned connectionId", () => {
  test("missing row is an error, not a prompt — the page names something gone", async () => {
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      connectionId: "conn-x",
    });
    expect(result.status).toBe("error");
  });

  test("someone else's personal connection resolves to needs_connection, never their account", async () => {
    pinned = row({ userId: "someone-else" });
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      connectionId: "conn-1",
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey: "acme-mail",
      displayName: "Acme Mail",
      reason: "pinned_to_another_user",
      candidates: [],
    });
  });

  test("a non-active pinned connection is an error that names its state", async () => {
    pinned = row({ status: "disabled" });
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      connectionId: "conn-1",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("disabled");
    }
  });

  test("a team-shared pin resolves for any viewer; an own personal pin too", async () => {
    pinned = row({ userId: null });
    const shared = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      connectionId: "conn-1",
    });
    expect(shared.status).toBe("ok");

    pinned = row({ userId: "user-1" });
    const personal = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      connectionId: "conn-1",
    });
    expect(personal.status).toBe("ok");
  });
});

describe("providerKey resolution — personal first, team second", () => {
  test("the viewer's personal connection beats the team's shared one", async () => {
    candidates = [
      row({ id: "team-conn", userId: null }),
      row({ id: "mine", userId: "user-1" }),
    ];
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe("mine");
    }
  });

  test("no personal connection falls back to the team's", async () => {
    candidates = [row({ id: "team-conn", userId: null })];
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe("team-conn");
    }
  });

  test("no connection at all is the connect prompt, and says nobody has one", async () => {
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey: "acme-mail",
      reason: "none",
      candidates: [],
    });
  });

  test("a connection that exists but cannot be used is a DIFFERENT no", async () => {
    // "Connect your account" is the wrong instruction when the account is
    // there and broken — connecting a second one fixes nothing. This is the
    // distinction a user got stuck on.
    candidates = [row({ id: "team-conn", userId: null, status: "error" })];
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey: "acme-mail",
      reason: "unusable",
      candidates: [
        {
          id: "team-conn",
          displayName: "Acme Mail",
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
    candidates = [
      row({
        id: "older",
        userId: "user-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      row({
        id: "newer",
        userId: "user-1",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ];
    const resolvedTie = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(resolvedTie.status).toBe("ok");
    if (resolvedTie.status === "ok") {
      expect(resolvedTie.connection.id).toBe("newer");
      expect(resolvedTie.candidates).toHaveLength(2);
    }

    candidates = [
      row({ id: "team-a", userId: null }),
      row({ id: "team-b", userId: null }),
      row({ id: "mine", userId: "user-1" }),
    ];
    const resolved = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") {
      expect(resolved.connection.id).toBe("mine");
    }
  });

  test("an anonymous viewer queries the team tier only", async () => {
    candidates = [];
    await resolvePageConnection({
      teamId: "team-1",
      userId: null,
      providerKey: "acme-mail",
    });
    const where = findManyWheres[0] ?? {};
    // No OR branch — the where pins userId to IS NULL outright.
    expect("OR" in where).toBe(false);
    expect(where["userId"]).toEqual({ isNull: true });
  });

  test("neither pin nor provider is a definition defect", async () => {
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
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
  test("the snake_case module name queries the kebab-case key", async () => {
    candidates = [row({ id: "team-conn", userId: null })];
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme_mail",
    });
    expect(result.status).toBe("ok");
    expect(findManyWheres[0]?.["providerKey"]).toBe("acme-mail");
  });

  test("camelCase and upper case fold too", async () => {
    candidates = [];
    await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acmeMail",
    });
    expect(findManyWheres[0]?.["providerKey"]).toBe("acme-mail");

    findManyWheres.length = 0;
    await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "ACME_MAIL",
    });
    expect(findManyWheres[0]?.["providerKey"]).toBe("acme-mail");
  });

  test("the connect prompt names the FOLDED key, not what the page wrote", async () => {
    candidates = [];
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme_mail",
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey: "acme-mail",
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
    candidates = [
      row({ id: "team-conn", userId: null }),
      row({ id: "mine", userId: "user-1" }),
    ];
    preference = { connectionId: "team-conn", pageId: "page-1" };
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
      pageId: "page-1",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe("team-conn");
      expect(result.chosenBy).toBe("viewer_preference");
    }
  });

  test("a preference pointing at something unusable falls through, never fails", async () => {
    candidates = [
      row({ id: "gone", userId: null, status: "error" }),
      row({ id: "mine", userId: "user-1" }),
    ];
    preference = { connectionId: "gone", pageId: "page-1" };
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
      pageId: "page-1",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe("mine");
      expect(result.chosenBy).toBe("personal");
    }
  });

  test("the author's pin still wins — a pin means EVERYONE uses that account", async () => {
    pinned = row({ id: "pinned-conn", userId: null });
    preference = { connectionId: "mine", pageId: "page-1" };
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      connectionId: "pinned-conn",
      pageId: "page-1",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.connection.id).toBe("pinned-conn");
      expect(result.chosenBy).toBe("author_pin");
    }
  });
});
