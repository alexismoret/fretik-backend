import { verifySandboxJwt } from "@fretik/shared/lib/external-apps/sandbox-jwt";
import {
  responseBadRequestSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  sandboxExecRequestSchema,
  sandboxExecResponseSchema,
} from "@fretik/shared/schemas/sandbox";
import { dispatchSandboxExec } from "@fretik/shared/services/sandbox/dispatch";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `POST /sandbox/exec` — the callback the Python SDK (`fretik_apps._runtime`)
 * fires from inside the E2B sandbox.
 *
 * Auth is intentionally **NOT** the Better Auth cookie:
 *  - The sandbox runs in E2B with no access to user cookies.
 *  - The chatbot handler mints a per-turn JWT (HS256, 1h) and writes it
 *    to `/workspace/.fretik/auth.json` BEFORE running the python tool.
 *  - `_runtime.py` reads that file on every call and sends the JWT as a
 *    Bearer token here.
 *
 * The JWT is the ONLY thing this route trusts: it carries the
 * `conversationId / teamId / userId / organizationId / turnId` that
 * become the `ExecContext` for `dispatchSandboxExec`. The body's
 * `turnId` is double-checked against the JWT claim as defense in depth —
 * an attacker who replays a JWT with a different `turnId` in the body
 * gets a 401, not silent execution.
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
      description: "Invalid or missing sandbox JWT",
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
      : body.kind === "objects"
        ? `op=${body.op}`
        : `ops=${body.operations.length.toString()}`;
  console.info(
    `[sandbox/exec] dispatch kind=${body.kind} conversationId=${claims.conversationId} ${dispatchDetail}`,
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
      : body.kind === "objects"
        ? { kind: "objects", op: body.op, args: body.args }
        : { kind: "plan", operations: body.operations },
  );

  console.info(`[sandbox/exec] → status=${result.status}`);
  return c.json(result, 200);
});

export { sandboxRoutes };
