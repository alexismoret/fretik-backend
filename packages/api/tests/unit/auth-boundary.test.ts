import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";

import { mockModule } from "../lib/mock-module";
import type { Probeable } from "../lib/mounted-routers";

/**
 * Which routers answer a caller with no session.
 *
 * This package is a wall of `createRoute()` declarations around
 * `@fretik/shared` services, and the one thing those declarations do NOT say is
 * whether the router in front of them requires a session — that is a single
 * `routes.use("*", authMiddleware)` line at the top of each file. Forgetting it
 * on a new handler compiles, reviews as easily as any other missing line, and
 * publishes the whole resource to the internet. Nothing detected it.
 *
 * The probe is behavioural rather than a grep for the middleware: a request to
 * a path a router does not define still runs the middleware registered on
 * `"*"`, so an unauthenticated GET comes back 401 where the wall exists and 404
 * where it does not. That survives someone applying auth by another mechanism,
 * and it catches someone who applies it to only some routes of a file.
 *
 * The five public routers are public on purpose, each with a comment in its own
 * file saying so. Listing them here makes "this endpoint is now anonymous" an
 * edit to this file rather than an accident nobody sees.
 *
 * Better Auth is doubled to answer "no session" — the state under test — so the
 * 401 is decided before any I/O and the whole probe runs against the preload's
 * dead ports. Its session store is a process boundary; nothing else is faked.
 */

await mockModule("@fretik/shared/lib/auth", {
  auth: {
    api: {
      getSession: (): Promise<null> => Promise.resolve(null),
    },
  },
});

const { MOUNTED_ROUTERS } = await import("../lib/mounted-routers");

/**
 * The routers a logged-out caller may reach, and why each is allowed to be.
 * Anything else answering without a session is a leak.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "/invitations":
    "a logged-out invitee must see who invited them before signing up",
  "/forms": "a public form is filled in by people who have no account",
  "/p": "publishing a page IS the decision to expose it",
  "/desktop-releases": "the download page is reachable before signing in",
  "/sandbox":
    "authenticated by a per-turn bearer JWT minted for the E2B sandbox, not by a session cookie",
};

/**
 * Two segments on purpose. A single-segment path matches the `/:token` routes
 * the public routers define, and those carry Redis-backed rate limiters that
 * would run before the probe learned anything — against a dead port, so the
 * request never returns. Nothing here defines a two-segment path ending in a
 * name of ours, so the probe reaches routing and stops.
 */
const PROBE_PATH = "/__probe__/__no_session__";

const probe = async (router: Probeable): Promise<number> => {
  const res = await router.request(PROBE_PATH, { method: "GET" });
  return res.status;
};

const routerAt = (mount: string): Probeable => {
  const router = MOUNTED_ROUTERS[mount];
  if (!router) throw new Error(`no router mounted at ${mount}`);
  return router;
};

describe("the session wall", () => {
  test("every mounted router is either session-gated or listed as public", async () => {
    const reachable: string[] = [];
    for (const [mount, router] of Object.entries(MOUNTED_ROUTERS)) {
      // eslint-disable-next-line no-await-in-loop -- serial keeps output readable
      if ((await probe(router)) !== 401) reachable.push(mount);
    }
    expect(reachable.sort()).toEqual(Object.keys(PUBLIC_BY_DESIGN).sort());
  });

  test("each private router answers 401, not 404, to a path it does not define", async () => {
    // Stated per router so a failure names the one that lost its wall. A 404
    // means the request reached routing without passing a session check.
    for (const [mount, router] of Object.entries(MOUNTED_ROUTERS)) {
      if (mount in PUBLIC_BY_DESIGN) continue;
      // eslint-disable-next-line no-await-in-loop -- serial keeps output readable
      const status = await probe(router);
      expect({ mount, status }).toEqual({ mount, status: 401 });
    }
  });

  test("the public list only excuses routers that are actually mounted", () => {
    // Keeps the allowlist from outliving what it excuses: a stale entry would
    // silently forgive a future router that reused the mount path.
    for (const mount of Object.keys(PUBLIC_BY_DESIGN)) {
      expect(Object.keys(MOUNTED_ROUTERS)).toContain(mount);
    }
  });

  test("an operator surface is behind the session wall before its own check", async () => {
    // `super-admins` and `signup-access` stack a super-admin middleware on top
    // of the session one. The order matters: a logged-out caller is turned away
    // by the session check, so the operator check never sees an anonymous
    // request at all.
    expect(await probe(routerAt("/super-admins"))).toBe(401);
    expect(await probe(routerAt("/signup-access"))).toBe(401);
  });

  test("the probe can tell the two answers apart", async () => {
    // A control. If `request()` ever returned 401 for everything — a doubled
    // module gone wrong, a middleware applied globally by accident — every
    // assertion above would pass while proving nothing. A public router
    // answering something else is what makes the 401s meaningful.
    expect(await probe(routerAt("/p"))).not.toBe(401);
  });
});
