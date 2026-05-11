import { createMiddleware } from "hono/factory";
import type { HonoInternalAppType } from "../types/hono";

const INTERNAL_KEY = process.env.INTERNAL_KEY;
if (!INTERNAL_KEY) {
  throw "Missing INTERNAL_KEY env";
}

/**
 * Authenticates server-to-server callers (@fretik/api, @fretik/worker)
 * on /internal/* routes. The caller passes:
 *   - `X-Internal-Key: <INTERNAL_KEY>`
 *   - `X-Context-Team-Id: <uuid>`
 *   - `X-Context-Organization-Id: <uuid>`
 *   - `X-Context-User-Id: <uuid>` (optional)
 *   - `X-Context-User-Name: <string>` (optional)
 *   - `X-Context-Timezone: <IANA>` (optional, e.g. `Europe/Paris`)
 *
 * The resulting `AgentRuntimeContextBase` is set on `c.get("context")`
 * and handed to the agent via `ChatbotCallOptions` — see
 * `handlers/chatbot.ts::/invoke`.
 */
export const internalMiddleware = createMiddleware<HonoInternalAppType>(
  async (c, next) => {
    const header = c.req.header("X-Internal-Key");
    if (!header || header !== INTERNAL_KEY) {
      return c.json(
        { code: "UNAUTHORIZED", message: "Invalid or missing X-Internal-Key" },
        401,
      );
    }

    const teamId = c.req.header("X-Context-Team-Id");
    const organizationId = c.req.header("X-Context-Organization-Id");
    if (!teamId || !organizationId) {
      return c.json(
        {
          code: "MISSING_CONTEXT",
          message:
            "X-Context-Team-Id and X-Context-Organization-Id headers are required",
        },
        400,
      );
    }

    c.set("context", {
      organizationId,
      teamId,
      userId: c.req.header("X-Context-User-Id"),
      userName: c.req.header("X-Context-User-Name"),
      timeZone: c.req.header("X-Context-Timezone"),
    });

    return next();
  },
);

/**
 * Lightweight internal-auth middleware for global cron / janitor
 * routes that don't operate in a team/org context (orphan cleanup,
 * cache purges, …). Only checks `X-Internal-Key`; no context is
 * populated because there's nothing meaningful to scope.
 */
export const internalCronMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header("X-Internal-Key");
  if (!header || header !== INTERNAL_KEY) {
    return c.json(
      { code: "UNAUTHORIZED", message: "Invalid or missing X-Internal-Key" },
      401,
    );
  }
  return next();
});
