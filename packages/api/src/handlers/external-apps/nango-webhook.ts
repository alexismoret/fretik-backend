import { access } from "@fretik/shared/authz/http";
import { type HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import {
  getNangoWebhookSecret,
  NANGO_HMAC_HEADER,
  verifyNangoWebhookSignature,
} from "@fretik/shared/lib/external-apps/nango-webhook-signature";
import {
  clientIp,
  createRedisRateLimitStore,
} from "@fretik/shared/lib/rate-limit";
import { responseInternalErrorSchema } from "@fretik/shared/schemas/common/responses";
import { handleNangoWebhook } from "@fretik/shared/services/external-apps/webhooks/handle-nango-webhook";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Inbound webhooks from our Nango instance.
 *
 * Intentionally UNAUTHENTICATED in the session sense — Nango holds no cookie
 * and no key of ours — so the HMAC signature is the authentication, checked
 * before the body is parsed and before anything is written. A request that
 * fails it is refused with 401 and nothing else happens.
 *
 * Subscribed to two events, both configured in the Nango dashboard:
 * `on_connection_deletion` (Environment Settings → Webhooks), which marks the
 * connection `error`, and `forward` — a provider's own webhook, relayed — which
 * brings that connection's incremental sync sources forward and does nothing
 * else. Every other type Nango may send is accepted and ignored: see
 * `decideNangoWebhook` for why ignoring beats rejecting.
 *
 * A `forward` delivery reaches this route only once an operator has registered
 * the integration's forwarding URL WITH THE PROVIDER (`OPERATIONS.md` §11).
 * Until then nothing arrives, and every source still runs on its schedule —
 * the webhook is an accelerator, never the mechanism.
 *
 * ## Why this answers 200 so readily
 *
 * Nango RETRIES a non-2xx. An error status is therefore a promise to do
 * better on the redelivery, and it is only honest when a retry could plausibly
 * succeed. A malformed body and an event type we do not handle will both fail
 * identically forever, so they answer 200 with `handled: false` — the delivery
 * arrived, there was nothing to do. A 401 is the one refusal worth retrying
 * from the sender's point of view (a rotated key, a misconfigured secret on
 * our side), and a 500 means our database was unreachable, which is exactly
 * what a redelivery should retry.
 */
const nangoWebhookRoutes = new OpenAPIHono<HonoLoggedAppType>();

/**
 * A public URL that does a database write per request needs its own bucket.
 * Generous, because the limit exists to bound an abuser rather than Nango: a
 * deployment sees a handful of these a day, and a burst of deletions during a
 * mass cleanup is legitimate.
 */
nangoWebhookRoutes.use(
  "/nango",
  rateLimiter({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `ip:${clientIp(c)}`,
    store: createRedisRateLimitStore("rl:nango-webhook:"),
    requestPropertyName: "rateLimitNangoWebhook",
  }),
);

const webhookAckSchema = z.object({
  handled: z.boolean().openapi({
    description: "Whether the delivery changed anything on our side.",
  }),
  action: z.string().openapi({ example: "connection-deleted-upstream" }),
});

const webhookRoute = createRoute({
  method: "post",
  path: "/nango",
  middleware: access.public(
    "Inbound from Nango, which holds no session: an HMAC over the raw body authenticates it.",
  ),
  summary: "Inbound Nango webhook (HMAC-signed)",
  description:
    "Authenticated by the `X-Nango-Hmac-Sha256` header over the raw body, using the environment's webhook signing key. Handles `auth` / `deletion`; acknowledges everything else without acting.",
  tags: ["External apps"],
  responses: {
    200: {
      content: { "application/json": { schema: webhookAckSchema } },
      description: "Delivery accepted (acted on, or knowingly ignored)",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Missing or wrong signature",
    },
    ...responseInternalErrorSchema,
  },
});

nangoWebhookRoutes.openapi(webhookRoute, async (c) => {
  // The RAW text, never `c.req.json()`: Nango signs the exact bytes it sent,
  // and a parse-then-reserialise round trip changes key order and whitespace,
  // so the signature of the same data no longer matches.
  const rawBody = await c.req.text();
  const signature = c.req.header(NANGO_HMAC_HEADER);

  // Header first, secret second. `getNangoWebhookSecret` throws when the env
  // var is missing — which is the right behaviour, since the alternative is an
  // unauthenticated endpoint that accepts everything — but it should be the
  // operator's 500, not one an unsigned request from anyone can provoke.
  if (signature === undefined || signature === "") {
    return c.json({ error: "invalid signature" }, 401);
  }
  if (
    !verifyNangoWebhookSignature({
      rawBody,
      signature,
      secret: getNangoWebhookSecret(),
    })
  ) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Signed by us and still not JSON — nothing a redelivery fixes.
    return c.json({ handled: false, action: "ignored" }, 200);
  }

  const decision = await handleNangoWebhook(body);
  return c.json(
    { handled: decision.action !== "ignored", action: decision.action },
    200,
  );
});

export { nangoWebhookRoutes };
