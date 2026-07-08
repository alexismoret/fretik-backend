import { createMiddleware } from "hono/factory";

/**
 * Authenticates the Trigger.dev orchestrator tasks on `/internal/trigger/*`.
 * Distinct key from `INTERNAL_KEY` on purpose: these routes are the ONLY
 * public surface of the AI service in prod (a dedicated hostname restricted
 * by Traefik), so leaking this key must not open the wider `/internal/*`
 * API. No `X-Context-*` headers — the run row is the source of scope.
 *
 * Lazy env check (not boot-time): the AI service must keep booting in
 * environments that don't run workflows yet; the first call then fails
 * loudly with an explicit message.
 */
export const triggerCallbackMiddleware = createMiddleware(async (c, next) => {
  const expected = process.env.TRIGGER_CALLBACK_KEY;
  if (expected === undefined || expected === "") {
    console.error(
      "[trigger-callback] TRIGGER_CALLBACK_KEY is not set — /internal/trigger/* is unusable until the operator configures it.",
    );
    return c.json(
      { code: "NOT_CONFIGURED", message: "TRIGGER_CALLBACK_KEY is not set" },
      503,
    );
  }
  const header = c.req.header("X-Trigger-Key");
  if (!header || header !== expected) {
    return c.json(
      { code: "UNAUTHORIZED", message: "Invalid or missing X-Trigger-Key" },
      401,
    );
  }
  return next();
});
