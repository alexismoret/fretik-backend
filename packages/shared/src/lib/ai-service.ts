import type { z } from "zod";

// ==================== //
// CONFIGURATION        //
// ==================== //

const AI_SERVICE_URL = process.env.AI_SERVICE_URL;
const INTERNAL_KEY = process.env.INTERNAL_KEY;

if (!AI_SERVICE_URL) {
  throw "Missing AI_SERVICE_URL env";
}
if (!INTERNAL_KEY) {
  throw "Missing INTERNAL_KEY env";
}

const AI_SERVICE_BASE_URL = AI_SERVICE_URL.replace(/\/$/, "");

// ==================== //
// REQUEST CONTEXT      //
// ==================== //

/**
 * Per-call context forwarded as `X-Context-*` headers. The @fretik/ai
 * `internalMiddleware` uses these to populate `AgentContext` on every
 * internal route. For `/internal/vectorize` specifically, `teamId` and
 * `organizationId` ALSO live in the body — the middleware still requires
 * the headers because all internal routes share the same auth layer.
 */
export interface AiServiceContext {
  teamId: string;
  organizationId: string;
  userId?: string;
  userName?: string;
  timeZone?: string;
}

interface CallAiServiceOptions {
  /** Request timeout in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
}

// ==================== //
// GENERIC CLIENT       //
// ==================== //

/**
 * POST to a `@fretik/ai` internal endpoint with Zod-validated JSON response.
 *
 * Throws on non-2xx responses, network errors, and schema-validation
 * failures so the caller's try/catch can log + swallow as needed.
 */
export const callAiService = async <T extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: T,
  ctx: AiServiceContext,
  options?: CallAiServiceOptions,
): Promise<z.infer<T>> => {
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${AI_SERVICE_BASE_URL}${normalisedPath}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Key": INTERNAL_KEY,
    "X-Context-Team-Id": ctx.teamId,
    "X-Context-Organization-Id": ctx.organizationId,
  };
  if (ctx.userId) headers["X-Context-User-Id"] = ctx.userId;
  if (ctx.userName) headers["X-Context-User-Name"] = ctx.userName;
  if (ctx.timeZone) headers["X-Context-Timezone"] = ctx.timeZone;

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `AI service request to ${normalisedPath} failed: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText}` : ""
        }`,
      );
    }

    const data: unknown = await response.json();
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `AI service returned an invalid response from ${normalisedPath}: ${result.error.message}`,
      );
    }

    return result.data;
  } finally {
    clearTimeout(timeoutId);
  }
};
