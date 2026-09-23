import { DecisionRequestSchema } from "@fretik/shared/schemas/decisions";
import { OpenAPIHono } from "@hono/zod-openapi";
import { withNamedTrace } from "../lib/trace-tool";
import { internalMiddleware } from "../middlewares/internal";
import {
  decidePoint,
  decisionRequestError,
} from "../services/decisions/decide-point";
import type { HonoInternalAppType } from "../types/hono";

/**
 * POST /internal/decisions
 *
 * Server-to-server decision endpoint. The callers are background workers —
 * the workflow trigger gate, the Drive filer — which live outside this
 * package and must not hold a provider key: every model call in this product
 * goes through this service, because this is where the keys, the transports
 * and the tracing are.
 *
 * Answers 200 in every case that is not a bug:
 * - `answered`, with a per-question `missing` list — a partial outage is
 *   partial, and the caller falls open on the missing ids only;
 * - `skipped`, when the point is off, its content may not leave, or the
 *   per-minute budget refused it — none of which is an incident.
 *
 * 400 means the REQUEST is wrong (a question that belongs to no family of
 * its point, or of the wrong kind): our bug, never retried.
 *
 * Opened as its own named trace, because a worker's call has no parent turn
 * to nest under; the costed `decision` generations sit inside it, and the
 * point rides as a tag so cost splits per decision point.
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
  const requestError = decisionRequestError(parsed.data);
  if (requestError !== null) {
    console.error(`[decisions] rejected request: ${requestError}`);
    return c.json({ code: "VALIDATION_ERROR", message: requestError }, 400);
  }

  const context = c.get("context");
  try {
    const result = await withNamedTrace(
      "decision",
      {
        ...(parsed.data.sessionId !== undefined
          ? { sessionId: parsed.data.sessionId }
          : {}),
        tags: [`decision:${parsed.data.point}`],
        metadata: { point: parsed.data.point, teamId: context.teamId },
      },
      () =>
        decidePoint(parsed.data, {
          teamId: context.teamId,
          organizationId: context.organizationId,
        }),
    );
    return c.json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[decisions] unexpected failure:", message);
    return c.json({ code: "DECISION_ERROR", message }, 500);
  }
});

export { decisionRoutes };
