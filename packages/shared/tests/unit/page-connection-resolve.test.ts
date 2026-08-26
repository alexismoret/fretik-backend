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
}

let pinned: Row | undefined;
let candidates: Row[] = [];
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
  ...extra,
});

beforeEach(() => {
  pinned = undefined;
  candidates = [];
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

  test("no connection at all is the connect prompt", async () => {
    const result = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(result).toEqual({
      status: "needs_connection",
      providerKey: "acme-mail",
    });
  });

  test("two candidates in the WINNING tier are ambiguous; a crowded losing tier is not", async () => {
    candidates = [
      row({ id: "a", userId: "user-1" }),
      row({ id: "b", userId: "user-1" }),
    ];
    const ambiguous = await resolvePageConnection({
      teamId: "team-1",
      userId: "user-1",
      providerKey: "acme-mail",
    });
    expect(ambiguous.status).toBe("error");
    if (ambiguous.status === "error") {
      expect(ambiguous.message).toContain("connectionId");
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
