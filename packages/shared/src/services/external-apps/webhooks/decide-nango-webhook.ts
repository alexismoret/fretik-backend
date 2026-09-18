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
 * We subscribe to exactly one — `auth` with `operation: "deletion"`, the
 * `on_connection_deletion` toggle — and the schema is written for that one.
 * Everything else must parse-fail cleanly and be IGNORED rather than
 * rejected: Nango retries a non-2xx, so answering an error to an event we
 * simply do not care about buys a redelivery loop over an event we will
 * never act on.
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

export type NangoWebhookDecision =
  | {
      action: "connection-deleted-upstream";
      nangoConnectionId: string;
      nangoProviderConfigKey: string;
      reason: string;
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
 */
export const decideNangoWebhook = (body: unknown): NangoWebhookDecision => {
  const parsed = nangoAuthWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { action: "ignored", reason: "not an auth webhook" };
  }
  if (parsed.data.operation !== "deletion") {
    return { action: "ignored", reason: `auth ${parsed.data.operation}` };
  }
  return {
    action: "connection-deleted-upstream",
    nangoConnectionId: parsed.data.connectionId,
    nangoProviderConfigKey: parsed.data.providerConfigKey,
    // Read by a human in the settings UI, under a Reconnect button — so it
    // says what happened and what to do, not which webhook fired.
    reason:
      "This connection was removed from the credential vault. Reconnect to use it again.",
  };
};
