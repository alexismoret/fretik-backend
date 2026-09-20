import {
  DecisionRequestSchema,
  type DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import { OpenAPIHono } from "@hono/zod-openapi";
import { internalMiddleware } from "../middlewares/internal";
import {
  DecisionUnavailableError,
  decisionsEnabled,
  evaluateDecisions,
} from "../services/decisions/evaluate";
import type { HonoInternalAppType } from "../types/hono";

/**
 * POST /internal/decisions
 *
 * Server-to-server decision endpoint. The callers are background workers —
 * the workflow trigger gate today — which live in `@fretik/jobs` and must not
 * import `@fretik/ai`: every model call in this product goes through this
 * service, because this is where the provider keys, the transport and the
 * Langfuse tracing are.
 *
 * It answers 503 rather than 500 when the decision could not be made, and the
 * distinction is the contract: a caller reading 503 has learned "no answer
 * available" and takes its fail-open path, which for the trigger gate means
 * launching the workflow exactly as it did before any of this existed. There
 * is no state on this endpoint and nothing to roll back — asking again later
 * is always safe.
 */

const decisionRoutes = new OpenAPIHono<HonoInternalAppType>();
decisionRoutes.use("*", internalMiddleware);

decisionRoutes.post("/", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = DecisionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }

  try {
    const result: DecisionResponse = await evaluateDecisions(parsed.data);
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof DecisionUnavailableError) {
      // `disabled` is the operator kill switch, not an incident — it logs at
      // info so flipping it off does not fill the error budget with noise
      // that the operator caused on purpose.
      const log = error.reason === "disabled" ? console.info : console.warn;
      log(`[decisions] unavailable (${error.reason}): ${error.message}`);
      return c.json(
        { code: "DECISION_UNAVAILABLE", reason: error.reason },
        503,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[decisions] unexpected failure:", message);
    return c.json({ code: "DECISION_ERROR", message }, 500);
  }
});

/** Whether this deployment will answer decisions at all — for /health. */
export const decisionsAvailable = decisionsEnabled;

export { decisionRoutes };
