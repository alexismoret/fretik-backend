import { auth } from "@fretik/shared/lib/auth";
import { type HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import {
  clientIp,
  createRedisRateLimitStore,
} from "@fretik/shared/lib/rate-limit";
import { responseInternalErrorSchema } from "@fretik/shared/schemas/common/responses";
import {
  PublicFormResponseSchema,
  type PublicFormAccess,
} from "@fretik/shared/schemas/workflow-forms";
import { serializePublicForm } from "@fretik/shared/services/workflows/get-public-form";
import { resolveFormAccess } from "@fretik/shared/services/workflows/resolve-form-access";
import { submitWorkflowForm } from "@fretik/shared/services/workflows/submit-form";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { z } from "zod";

/**
 * Public form routes — the ingress for the `form` trigger's `/f/<token>` page.
 * Intentionally UNAUTHENTICATED (no `authMiddleware`, mirrors `invitations.ts`):
 * a public form is fillable by anyone with the link, a private one falls back
 * to the workflow's own scope, resolved per-request from the OPTIONAL Better
 * Auth session. The submit route carries stricter, Redis-backed throttles
 * (per-IP + per-form) on top of the app-wide limiter so an open endpoint can't
 * be spammed into unbounded runs.
 */
const publicFormRoutes = new OpenAPIHono<HonoLoggedAppType>();

/** The signed-in user's id, or undefined for an anonymous visitor. Read from
 * the optional Better Auth session (no middleware — this route allows both). */
const optionalUserId = async (c: Context): Promise<string | undefined> => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user.id;
};

const accessStatus: Record<
  Exclude<PublicFormAccess, "ready">,
  401 | 403 | 404 | 409
> = {
  not_found: 404,
  inactive: 409,
  login_required: 401,
  forbidden: 403,
};

// ==================== //
// GET form config      //
// ==================== //

const getFormRoute = createRoute({
  method: "get",
  path: "/{token}",
  summary: "Public form definition + access verdict for a form workflow",
  tags: ["Forms"],
  request: { params: z.object({ token: z.string().min(1) }) },
  responses: {
    200: {
      content: { "application/json": { schema: PublicFormResponseSchema } },
      description: "Access verdict (+ the form when access is `ready`)",
    },
    ...responseInternalErrorSchema,
  },
});

publicFormRoutes.openapi(getFormRoute, async (c) => {
  const { token } = c.req.valid("param");
  const userId = await optionalUserId(c);
  const result = await resolveFormAccess({ token, userId });

  if (result.access !== "ready") {
    return c.json({ access: result.access }, 200);
  }
  const form = await serializePublicForm(result.workflow, result.form);
  return c.json({ access: "ready" as const, mode: result.mode, form }, 200);
});

// ==================== //
// POST submit          //
// ==================== //

// Stricter submit throttles on top of the app-wide limiter: a per-IP burst
// cap + a per-form global cap. Distinct `requestPropertyName`s + store prefixes
// so the two coexist. Redis-backed → shared across instances.
publicFormRoutes.use(
  "/:token/submit",
  rateLimiter({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `ip:${clientIp(c)}`,
    store: createRedisRateLimitStore("rl:form-ip:"),
    requestPropertyName: "rateLimitFormIp",
  }),
  rateLimiter({
    windowMs: 60 * 60_000,
    limit: 100,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `form:${c.req.param("token") ?? "unknown"}`,
    store: createRedisRateLimitStore("rl:form-cap:"),
    requestPropertyName: "rateLimitFormCap",
  }),
);

// Plain route (not `createRoute`) because the body is multipart with dynamic,
// per-field file parts — same pattern as the chat-files upload handler.
publicFormRoutes.post("/:token/submit", async (c) => {
  const token = c.req.param("token");
  const userId = await optionalUserId(c);
  const result = await resolveFormAccess({ token, userId });

  if (result.access !== "ready") {
    return c.json(
      { code: result.access.toUpperCase() },
      accessStatus[result.access],
    );
  }

  const body = await c.req.formData();

  // Scalar answers ride in one JSON `values` part; every File part is a file
  // field keyed by the field's key (multiple parts under one key = multi-file).
  let values: Record<string, unknown> = {};
  const valuesRaw = body.get("values");
  if (typeof valuesRaw === "string" && valuesRaw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(valuesRaw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        values = parsed as Record<string, unknown>;
      }
    } catch {
      return c.json(
        { code: "VALIDATION_ERROR", message: "Invalid form values." },
        400,
      );
    }
  }

  // Collect uploads for each declared file field (`getAll` returns the
  // File-inclusive union; `entries()` doesn't narrow it).
  const files = new Map<string, File[]>();
  for (const field of result.form.fields) {
    if (field.type !== "file") continue;
    const uploaded = body
      .getAll(field.key)
      .filter((v): v is File => v instanceof File);
    if (uploaded.length > 0) files.set(field.key, uploaded);
  }

  const outcome = await submitWorkflowForm({
    workflow: result.workflow,
    form: result.form,
    values,
    files,
    triggeredByUserId: userId ?? null,
    isTest: result.mode === "test",
  });

  if (!outcome.ok) {
    return c.json({ code: "VALIDATION_ERROR", message: outcome.message }, 400);
  }
  return c.json(
    {
      ok: true,
      ...(result.form.successMessage !== undefined
        ? { successMessage: result.form.successMessage }
        : {}),
      // A test submission returns its run so the cockpit can jump to it.
      ...(result.mode === "test"
        ? { runId: outcome.runId, workflowId: outcome.workflowId }
        : {}),
    },
    200,
  );
});

export { publicFormRoutes };
