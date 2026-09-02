import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import db from "../../../src/db";
import { teamMember } from "../../../src/db/schema";
import { redis } from "../../../src/lib/redis";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * `authMiddleware` — the code that decides the SCOPE of every authenticated
 * request in the product, and which nothing tested until 2026-09-02.
 *
 * It reads three rows and makes one judgement from them: the organization the
 * session names, the team the session names, and whether the caller is still a
 * member of that team. Handlers then take `c.get("team").id` as fact and hand
 * it to services as `teamId` — the same `teamId` every predicate converted in
 * `docs/TEST-TRIAGE.md` filters on. Those services are now proven to scope
 * correctly; this is where the value they scope BY comes from, so a defect
 * here is a cross-tenant leak that every downstream test would still pass.
 *
 * Two of its rules exist against a specific scenario, both written in the
 * source as comments and neither exercised:
 *
 *   - the session KEEPS its `activeTeamId` when the active organization
 *     changes, so the team it names may belong to somebody else's org;
 *   - team membership can be revoked mid-session, and the session outlives it.
 *
 * Better Auth's session store is a process boundary and is doubled — a session
 * is the INPUT here, not the subject. Everything the middleware then does with
 * it is real: real rows, real queries, real Redis cache.
 */

interface FakeSession {
  activeOrganizationId: string | null;
  activeTeamId: string | null;
}

/** The session Better Auth will answer with; `null` means "not signed in". */
let session: { user: { id: string }; session: FakeSession } | null = null;

await mockModule("../../src/lib/auth", {
  auth: {
    api: {
      getSession: () => Promise.resolve(session),
    },
  },
});

const { authMiddleware } = await import("../../../src/lib/auth-middleware");

let fx: WorkspaceFixture;
/** A second workspace: its team is the one a stale session points at. */
let otherFx: WorkspaceFixture;

/**
 * A minimal app: the middleware, then one route that reports what it decided.
 * Going through `request()` rather than calling the middleware directly is the
 * point — the 401 and the 403 are RESPONSES, and a handler that never runs is
 * how the caller learns it was refused.
 */
const app = new Hono().use("*", authMiddleware).get("/whoami", (c) =>
  c.json({
    userId: c.get("user").id,
    organizationId: c.get("organization").id,
    teamId: c.get("team")?.id ?? null,
  }),
);

const call = async (): Promise<{
  status: number;
  body: Record<string, unknown>;
}> => {
  const res = await app.request("/whoami", { method: "GET" });
  const body: unknown = await res.json();
  return {
    status: res.status,
    body:
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {},
  };
};

const signedInAs = (
  userId: string,
  overrides: Partial<FakeSession> = {},
): void => {
  session = {
    user: { id: userId },
    session: {
      activeOrganizationId: fx.organizationId,
      activeTeamId: fx.teamId,
      ...overrides,
    },
  };
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  otherFx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
  await otherFx.cleanup();
});

beforeEach(async () => {
  session = null;
  // The middleware caches all three reads. Ids are random per fixture so no
  // value survives a suite, but a test that CHANGES a row (revoking a
  // membership) would otherwise read the answer its own earlier call cached.
  await redis.del(
    `organization:${fx.organizationId}`,
    `team:${fx.teamId}`,
    `team:${otherFx.teamId}`,
    `team:${fx.teamId}:member:${fx.userIds[0]}`,
    `team:${fx.teamId}:member:${fx.userIds[1]}`,
  );
});

describe("no session, no scope", () => {
  test("an unauthenticated request is 401 and reaches no handler", async () => {
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body["message"]).toBe("Unauthorized");
  });

  test("a session with no active organization is 403, and says which", async () => {
    signedInAs(fx.userIds[0], { activeOrganizationId: null });
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body["code"]).toBe("ORGANIZATION_REQUIRED");
  });

  test("an organization the database does not have is 404", async () => {
    // A deleted org whose session outlived it. Falling through with no
    // organization set would hand every downstream service `undefined`.
    signedInAs(fx.userIds[0], {
      activeOrganizationId: "01a00000-0000-7000-8000-0000000000ff",
    });
    const { status, body } = await call();
    expect(status).toBe(404);
    expect(body["code"]).toBe("ORGANIZATION_NOT_FOUND");
  });
});

describe("the team the session names", () => {
  test("a member of the named team gets it", async () => {
    // Without this, every refusal below is satisfied by a middleware that
    // resolves no team at all, ever.
    signedInAs(fx.userIds[0]);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body["teamId"]).toBe(fx.teamId);
    expect(body["organizationId"]).toBe(fx.organizationId);
  });

  test("no active team resolves to null, not to an arbitrary one", async () => {
    signedInAs(fx.userIds[0], { activeTeamId: null });
    const { body } = await call();
    expect(body["teamId"]).toBeNull();
  });

  test("a team of ANOTHER organization is refused, even to a MEMBER of it", async () => {
    // The scenario the source names: the session keeps `activeTeamId` when the
    // active organization changes. Belonging to two organizations is ordinary,
    // so the interesting caller is one the membership check WAVES THROUGH —
    // they really are in that team, just not under this organization. Only the
    // `organizationId` comparison stands between them and a request that runs
    // against another workspace's data under this org's name.
    //
    // Written first with a non-member and it proved nothing: the membership
    // query refused it anyway, so neutralising the org check left the suite
    // green. Two guards that refuse the same row test one guard.
    await db.insert(teamMember).values({
      userId: fx.userIds[0],
      teamId: otherFx.teamId,
      createdAt: new Date(),
    });
    await redis.del(`team:${otherFx.teamId}:member:${fx.userIds[0]}`);

    signedInAs(fx.userIds[0], { activeTeamId: otherFx.teamId });
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body["teamId"]).toBeNull();
    // And the organization is this session's, never the team's.
    expect(body["organizationId"]).toBe(fx.organizationId);
  });

  test("a team id that exists nowhere resolves to null", async () => {
    signedInAs(fx.userIds[0], {
      activeTeamId: "01a00000-0000-7000-8000-0000000000ff",
    });
    const { body } = await call();
    expect(body["teamId"]).toBeNull();
  });

  test("membership revoked mid-session drops the team", async () => {
    // A session outlives the membership it was issued under. The row is gone,
    // the team is in the right organization, and the id in the cookie is
    // still valid — only the membership query stands between this caller and
    // their former team's records.
    await db
      .delete(teamMember)
      .where(
        and(
          eq(teamMember.teamId, fx.teamId),
          eq(teamMember.userId, fx.userIds[1]),
        ),
      );

    signedInAs(fx.userIds[1]);
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body["teamId"]).toBeNull();

    // Put it back: the fixture's two users are shared by the whole file.
    await db.insert(teamMember).values({
      userId: fx.userIds[1],
      teamId: fx.teamId,
      createdAt: new Date(),
    });
  });
});

describe("the membership cache is per (team, user)", () => {
  test("one member's answer is not served to a non-member", async () => {
    // `team:${id}` is cached per TEAM — correct, it is the same row for
    // everyone. Membership is cached per PAIR, and this is the test that says
    // why: collapse that key to the team and the second caller below inherits
    // the first one's access to a team they were removed from.
    await db
      .delete(teamMember)
      .where(
        and(
          eq(teamMember.teamId, fx.teamId),
          eq(teamMember.userId, fx.userIds[1]),
        ),
      );

    signedInAs(fx.userIds[0]);
    expect((await call()).body["teamId"]).toBe(fx.teamId);

    signedInAs(fx.userIds[1]);
    expect((await call()).body["teamId"]).toBeNull();

    await db.insert(teamMember).values({
      userId: fx.userIds[1],
      teamId: fx.teamId,
      createdAt: new Date(),
    });
  });
});
