import { verifySandboxJwt } from "@fretik/shared/lib/external-apps/sandbox-jwt";
import { consumeRateLimit } from "@fretik/shared/lib/rate-limit";
import {
  responseBadRequestSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  sandboxExecRequestSchema,
  sandboxExecResponseSchema,
} from "@fretik/shared/schemas/sandbox";
import { getSandboxIdFromRegistry } from "@fretik/shared/services/e2b/registry";
import { dispatchSandboxExec } from "@fretik/shared/services/sandbox/dispatch";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * Ceiling per conversation per minute. Wide enough that a legitimate turn
 * doing bulk work never notices — the SDK batches record writes — and narrow
 * enough that a loop, or a stolen credential being mined, stops.
 */
const SANDBOX_EXEC_LIMIT_PER_MINUTE = (() => {
  const raw = Bun.env.SANDBOX_EXEC_RATE_LIMIT_PER_MINUTE;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
})();

/**
 * `POST /sandbox/exec` — the callback the Python SDK (`fretik_apps._runtime`)
 * fires from inside the E2B sandbox.
 *
 * Auth is intentionally **NOT** the Better Auth cookie:
 *  - The sandbox runs in E2B with no access to user cookies.
 *  - A per-turn JWT (HS256, 1h) is minted before the python tool runs, and
 *    reaches the request either through E2B's egress proxy (the credential
 *    never enters the VM) or, on deployments where injection is unavailable,
 *    through `/workspace/.fretik/auth.json`.
 *
 * The JWT is the ONLY thing this route trusts: it carries the
 * `conversationId / teamId / userId / organizationId / turnId` that become the
 * `ExecContext` for `dispatchSandboxExec`. Which makes it the tenancy
 * boundary, and is why it is checked three ways beyond its signature:
 *
 *  - **`sandboxId` against the live registry.** The token names the sandbox it
 *    was minted for; the registry says which sandbox the conversation is
 *    actually using. A token copied out of a workspace therefore dies with
 *    that sandbox instead of staying valid for the rest of its hour from
 *    anywhere on the internet. This is the one check that bounds a leak.
 *  - **`turnId` against the body.** Defense in depth against replaying one
 *    turn's token against another turn's payload.
 *  - **A per-conversation rate limit.** The global limiter keys on the client
 *    IP, and E2B's egress shares addresses across tenants, so one runaway
 *    conversation would otherwise eat a budget every other tenant draws from.
 */

const sandboxRoutes = new OpenAPIHono();

// No `authMiddleware` here — auth is bearer JWT, verified per-handler.

const execRoute = createRoute({
  method: "post",
  path: "/exec",
  summary: "Dispatch a read or plan request from the chatbot sandbox",
  description:
    "Called exclusively by `fretik_apps._runtime` from inside the E2B sandbox. Bearer auth uses the per-turn sandbox JWT minted by the chatbot handler (HS256, 1h TTL).\n\n- `kind: 'read'` — eager execution; the response carries the mapped data.\n- `kind: 'plan'` — gated execution; the dispatcher matches the plan to an existing approval (creating one if needed) and returns either the cached result, an `approval_pending` marker, or an explicit error.",
  tags: ["Sandbox"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: sandboxExecRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: sandboxExecResponseSchema } },
      description: "Dispatch result",
    },
    401: {
      content: {
        "application/json": {
          schema: sandboxExecResponseSchema,
        },
      },
      description:
        "Missing or invalid sandbox JWT, or a token whose sandbox is no longer live",
    },
    429: {
      content: {
        "application/json": {
          schema: sandboxExecResponseSchema,
        },
      },
      description: "Too many sandbox calls for this conversation this minute",
    },
    ...responseBadRequestSchema,
    ...responseInternalErrorSchema,
  },
});

sandboxRoutes.openapi(execRoute, async (c) => {
  // First-line trace — confirms the request reached our backend at all.
  // A missing log line here on a sandbox failure means the request was
  // killed earlier in the chain (E2B network policy, Cloudflare /
  // tunl.gg edge, reverse proxy, etc.). The User-Agent helps spot a
  // future bot-management false-positive at a glance.
  const ua = c.req.header("user-agent") ?? "<no-ua>";
  console.info(
    `[sandbox/exec] ← ${c.req.method} from ua="${ua}" len=${(c.req.header("content-length") ?? "?").toString()}`,
  );

  const auth = c.req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    console.warn("[sandbox/exec] 401 missing bearer");
    return c.json(
      { status: "error" as const, message: "Missing bearer token" },
      401,
    );
  }
  const token = auth.slice("Bearer ".length).trim();
  if (token === "") {
    console.warn("[sandbox/exec] 401 empty bearer");
    return c.json(
      { status: "error" as const, message: "Empty bearer token" },
      401,
    );
  }

  let claims;
  try {
    claims = await verifySandboxJwt(token);
  } catch (err) {
    console.warn(
      `[sandbox/exec] 401 invalid JWT: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json(
      { status: "error" as const, message: "Invalid sandbox JWT" },
      401,
    );
  }

  // The token names the sandbox it was minted for; the registry says which
  // sandbox this conversation is actually running. Without this check a token
  // copied out of a workspace stays valid for the rest of its hour from
  // anywhere — killing the sandbox, or letting it expire, did nothing to it.
  // The registry entry is cleared by `killSandbox` / `releaseSandbox` and
  // re-populated by every `acquireSandbox` before any code runs, so a live
  // sandbox is never rejected.
  const liveSandboxId = await getSandboxIdFromRegistry(claims.conversationId);
  if (liveSandboxId === null || liveSandboxId !== claims.sandboxId) {
    console.warn(
      `[sandbox/exec] 401 sandbox mismatch jti=${claims.jti} token=${claims.sandboxId} live=${liveSandboxId ?? "<none>"}`,
    );
    return c.json(
      { status: "error" as const, message: "Sandbox is no longer live" },
      401,
    );
  }

  // Per conversation, not per IP: E2B's egress shares addresses across
  // tenants, so the global per-IP limiter would let one runaway conversation
  // spend a budget every other tenant is also drawing from.
  const rate = await consumeRateLimit(
    "rl:sandbox-exec:",
    claims.conversationId,
  );
  if (rate.totalHits > SANDBOX_EXEC_LIMIT_PER_MINUTE) {
    console.warn(
      `[sandbox/exec] 429 conversation=${claims.conversationId} hits=${rate.totalHits.toString()}`,
    );
    return c.json(
      {
        status: "error" as const,
        message: `RATE_LIMITED: too many sandbox calls this minute (limit ${SANDBOX_EXEC_LIMIT_PER_MINUTE.toString()}). Batch the operations into one call and retry after ${rate.resetTime.toISOString()}.`,
      },
      429,
    );
  }

  const body = c.req.valid("json");

  // Defense in depth: the JWT's `turnId` and the body's `turnId` must
  // match. A replayed JWT against a different turn body returns 401
  // rather than silently dispatching on the wrong turn context.
  if (body.turnId !== claims.turnId) {
    console.warn(
      `[sandbox/exec] 401 turnId mismatch jwt=${claims.turnId} body=${body.turnId}`,
    );
    return c.json(
      { status: "error" as const, message: "turnId mismatch" },
      401,
    );
  }

  const dispatchDetail =
    body.kind === "read"
      ? `action=${body.action}`
      : body.kind === "collections"
        ? `op=${body.op}`
        : `ops=${body.operations.length.toString()}`;
  // One structured line per dispatch, keyed by `jti`. The credential is
  // per turn and single-use in practice, so the id ties any suspicious call
  // back to the turn that minted it — an anonymous 401 count cannot.
  console.info(
    JSON.stringify({
      evt: "sandbox_exec",
      jti: claims.jti,
      sandboxId: claims.sandboxId,
      conversationId: claims.conversationId,
      turnId: claims.turnId,
      organizationId: claims.organizationId,
      teamId: claims.teamId,
      userId: claims.userId,
      kind: body.kind,
      detail: dispatchDetail,
    }),
  );

  const ctx = {
    organizationId: claims.organizationId,
    teamId: claims.teamId,
    userId: claims.userId,
    conversationId: claims.conversationId,
    turnId: claims.turnId,
  };
  const result = await dispatchSandboxExec(
    ctx,
    body.kind === "read"
      ? { kind: "read", action: body.action, args: body.args }
      : body.kind === "collections"
        ? { kind: "collections", op: body.op, args: body.args }
        : { kind: "plan", operations: body.operations },
  );

  // Single-flight deferral is a chat-side concept; the sandbox SDK only knows
  // ok / approval_pending / error. Surface it as a clear error so the model
  // waits for the pending review and re-runs, without teaching the SDK a new
  // status (no template rebuild). Early return keeps `result` narrowed to the
  // three wire statuses for the normal path.
  if (result.status === "approval_deferred") {
    console.info("[sandbox/exec] → status=approval_deferred (→ error)");
    return c.json(
      {
        status: "error" as const,
        message:
          "APPROVAL_DEFERRED: a review is already pending in this conversation. Stop and wait for it to be resolved, then re-run this.",
      },
      200,
    );
  }

  console.info(`[sandbox/exec] → status=${result.status}`);
  return c.json(result, 200);
});

export { sandboxRoutes };
