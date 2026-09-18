import "@hono/zod-openapi";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * Who `POST /sandbox/exec` lets through.
 *
 * This route has no session and no middleware: a bearer token IS the tenancy
 * decision, and whatever it claims becomes the org, team and user every
 * dispatched read and write runs as. It had no test at all.
 *
 * The case that matters most is the sandbox binding. Before it, a token
 * lifted out of a workspace — which agent code can read, since the sandbox
 * runs as root — stayed valid for the rest of its hour from anywhere on the
 * internet, and killing the sandbox did nothing to it. The registry lookup is
 * what makes the credential die with the sandbox it was minted for, so each
 * mismatch below is a leak that no longer pays.
 */

interface Claims {
  conversationId: string;
  teamId: string;
  userId: string;
  organizationId: string;
  turnId: string;
  sandboxId: string;
  jti: string;
}

const CLAIMS: Claims = {
  conversationId: "conv-1",
  teamId: "team-1",
  userId: "user-1",
  organizationId: "org-1",
  turnId: "turn-1",
  sandboxId: "sbx-live",
  jti: "jti-1",
};

/** What the doubles answer, reset per test. */
const scenario: {
  verify: Claims | Error;
  liveSandboxId: string | null;
  rateHits: number;
  dispatched: unknown[];
} = {
  verify: CLAIMS,
  liveSandboxId: "sbx-live",
  rateHits: 1,
  dispatched: [],
};

await mockModule("@fretik/shared/lib/external-apps/sandbox-jwt", {
  verifySandboxJwt: (): Promise<Claims> => {
    if (scenario.verify instanceof Error) {
      return Promise.reject(scenario.verify);
    }
    return Promise.resolve(scenario.verify);
  },
});

await mockModule("@fretik/shared/services/e2b/registry", {
  getSandboxIdFromRegistry: (): Promise<string | null> =>
    Promise.resolve(scenario.liveSandboxId),
});

await mockModule("@fretik/shared/lib/rate-limit", {
  consumeRateLimit: (): Promise<{ totalHits: number; resetTime: Date }> =>
    Promise.resolve({ totalHits: scenario.rateHits, resetTime: new Date(0) }),
});

await mockModule("@fretik/shared/services/sandbox/dispatch", {
  dispatchSandboxExec: (
    ctx: unknown,
  ): Promise<{ status: "ok"; data: unknown }> => {
    scenario.dispatched.push(ctx);
    return Promise.resolve({ status: "ok", data: { ok: true } });
  },
});

const { sandboxRoutes } =
  await import("../../src/handlers/external-apps/sandbox-exec");

const BODY = {
  kind: "read" as const,
  action: "outlook.list_messages",
  args: {},
  turnId: "turn-1",
};

const post = async (options: {
  authorization?: string;
  body?: unknown;
}): Promise<Response> =>
  sandboxRoutes.request("/exec", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.authorization === undefined
        ? {}
        : { Authorization: options.authorization }),
    },
    body: JSON.stringify(options.body ?? BODY),
  });

beforeEach(() => {
  scenario.verify = CLAIMS;
  scenario.liveSandboxId = "sbx-live";
  scenario.rateHits = 1;
  scenario.dispatched = [];
});

describe("POST /sandbox/exec — the bearer is the tenancy decision", () => {
  test("a valid token dispatches with exactly the claims it carries", async () => {
    const response = await post({ authorization: "Bearer good-token" });
    expect(response.status).toBe(200);
    expect(scenario.dispatched).toEqual([
      {
        organizationId: "org-1",
        teamId: "team-1",
        userId: "user-1",
        conversationId: "conv-1",
        turnId: "turn-1",
      },
    ]);
  });

  test("no Authorization header dispatches nothing", async () => {
    const response = await post({});
    expect(response.status).toBe(401);
    expect(scenario.dispatched).toHaveLength(0);
  });

  test("a bearer with no token dispatches nothing", async () => {
    // HTTP trims header values, so `"Bearer   "` arrives as `"Bearer"` and is
    // caught by the prefix check rather than the empty-token one. Both answer
    // 401; the point here is that neither reaches a dispatch.
    const response = await post({ authorization: "Bearer   " });
    expect(response.status).toBe(401);
    expect(scenario.dispatched).toHaveLength(0);
  });

  test("a token that fails verification dispatches nothing", async () => {
    scenario.verify = new Error("signature verification failed");
    const response = await post({ authorization: "Bearer forged" });
    expect(response.status).toBe(401);
    expect(scenario.dispatched).toHaveLength(0);
  });
});

describe("POST /sandbox/exec — the credential dies with its sandbox", () => {
  test("a token whose sandbox is gone is refused", async () => {
    // What `killSandbox` and the registry TTL leave behind.
    scenario.liveSandboxId = null;
    const response = await post({ authorization: "Bearer good-token" });
    expect(response.status).toBe(401);
    expect(scenario.dispatched).toHaveLength(0);
  });

  test("a token replayed against a conversation's NEW sandbox is refused", async () => {
    // The conversation is live again on a different sandbox; a token captured
    // from the previous one must not ride along.
    scenario.liveSandboxId = "sbx-different";
    const response = await post({ authorization: "Bearer stolen" });
    expect(response.status).toBe(401);
    expect(scenario.dispatched).toHaveLength(0);
  });
});

describe("POST /sandbox/exec — replay and flood", () => {
  test("a token replayed against another turn's body is refused", async () => {
    const response = await post({
      authorization: "Bearer good-token",
      body: { ...BODY, turnId: "some-other-turn" },
    });
    expect(response.status).toBe(401);
    expect(scenario.dispatched).toHaveLength(0);
  });

  test("past the per-conversation ceiling the call is refused, not queued", async () => {
    scenario.rateHits = 121;
    const response = await post({ authorization: "Bearer good-token" });
    expect(response.status).toBe(429);
    expect(scenario.dispatched).toHaveLength(0);
    const payload: unknown = await response.json();
    expect(JSON.stringify(payload)).toContain("RATE_LIMITED");
  });

  test("at the ceiling the call still goes through", async () => {
    scenario.rateHits = 120;
    const response = await post({ authorization: "Bearer good-token" });
    expect(response.status).toBe(200);
    expect(scenario.dispatched).toHaveLength(1);
  });
});
