import { z } from "zod";

/**
 * Decide what a Nango webhook means for us, without touching the database.
 *
 * Split out from `handleNangoWebhook` on purpose: the decision is the part
 * with the edge cases (which event types matter, which are noise, what a
 * malformed body should do) and the part worth testing, and it has no reason
 * to need a Postgres connection to be exercised.
 */

/**
 * The events Nango can deliver: `sync`, `auth`, `forward`, `async_action`.
 *
 * We subscribe to two — `auth` with `operation: "deletion"` (the
 * `on_connection_deletion` toggle) and `forward` (a provider's own webhook,
 * relayed) — and there is a schema per subscribed type. Everything else must
 * parse-fail cleanly and be IGNORED rather than rejected: Nango retries a
 * non-2xx, so answering an error to an event we simply do not care about buys
 * a redelivery loop over an event we will never act on.
 *
 * Deliberately not `.strict()`. Nango adds fields to this body between
 * versions (`tags` and `endUser` arrived this way), and a connection going
 * unnoticed because a new optional field appeared would be a bad trade for
 * the strictness.
 */
const nangoAuthWebhookSchema = z.object({
  from: z.literal("nango"),
  type: z.literal("auth"),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  operation: z.enum(["creation", "override", "refresh", "deletion", "unknown"]),
  provider: z.string().optional(),
  environment: z.string().optional(),
});

export type NangoAuthWebhook = z.infer<typeof nangoAuthWebhookSchema>;

/**
 * A provider's own webhook, relayed by Nango.
 *
 * `payload` is deliberately NOT read. Its shape is the provider's, so parsing
 * it would mean one parser per app, each guessing which of that app's events
 * touches which of our sources, each silently wrong when the provider changes
 * it. The event carries one fact we can trust across every app — SOMETHING
 * changed on this connection — and the incremental run that follows is what
 * says what. A webhook that only decides WHEN to ask costs one boolean per
 * provider; one that decides WHAT to fetch costs a parser per provider and
 * breaks per provider.
 */
const nangoForwardWebhookSchema = z.object({
  from: z.literal("nango"),
  type: z.literal("forward"),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  provider: z.string().optional(),
  environment: z.string().optional(),
});

export type NangoForwardWebhook = z.infer<typeof nangoForwardWebhookSchema>;

export type NangoWebhookDecision =
  | {
      action: "connection-deleted-upstream";
      nangoConnectionId: string;
      nangoProviderConfigKey: string;
      reason: string;
    }
  | {
      /** The app says something changed. Ask its incremental sources sooner. */
      action: "app-notified";
      nangoConnectionId: string;
      nangoProviderConfigKey: string;
    }
  | { action: "ignored"; reason: string };

/**
 * `creation` and `override` are the normal end of a connect flow, and we
 * already learn about those from the Connect UI callback that the browser
 * makes to `/external-apps/connections` — acting on the webhook too would
 * race our own row insert.
 *
 * `refresh` only fires on ERROR (Nango's `on_auth_refresh_error` toggle), so
 * it is genuinely interesting, but the lazy path already covers it: the next
 * call throws, `isAuthFailure` matches, and the row flips. Wiring it here as
 * well would mark the row twice with two different messages. Left alone
 * until there is a reason.
 *
 * `sync` and `async_action` belong to Nango features we do not use (their
 * hosted syncs, their long-running actions), and both stay ignored BY NAME
 * rather than by falling through — a body we recognise and decline is a
 * different fact from one we could not parse, and the reason string is what
 * tells the two apart in a log.
 */
export const decideNangoWebhook = (body: unknown): NangoWebhookDecision => {
  const auth = nangoAuthWebhookSchema.safeParse(body);
  if (auth.success) {
    if (auth.data.operation !== "deletion") {
      return { action: "ignored", reason: `auth ${auth.data.operation}` };
    }
    return {
      action: "connection-deleted-upstream",
      nangoConnectionId: auth.data.connectionId,
      nangoProviderConfigKey: auth.data.providerConfigKey,
      // Read by a human in the settings UI, under a Reconnect button — so it
      // says what happened and what to do, not which webhook fired.
      reason:
        "This connection was removed from the credential vault. Reconnect to use it again.",
    };
  }

  const forward = nangoForwardWebhookSchema.safeParse(body);
  if (forward.success) {
    return {
      action: "app-notified",
      nangoConnectionId: forward.data.connectionId,
      nangoProviderConfigKey: forward.data.providerConfigKey,
    };
  }

  return { action: "ignored", reason: "not a webhook we subscribe to" };
};
