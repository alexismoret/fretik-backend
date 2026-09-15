import { markConnectionAsError } from "../connections/mark-as-error";
import {
  decideNangoWebhook,
  type NangoWebhookDecision,
} from "./decide-nango-webhook";

/**
 * Apply a verified Nango webhook.
 *
 * What this buys: until now a connection deleted on the Nango side stayed
 * `active` in our database until something tried to use it and threw
 * `unknown_connection`. For a connection an agent touches hourly that is a
 * few minutes; for one behind a weekly workflow it is a week of a settings
 * page saying everything is fine. The webhook closes that window — the row
 * turns `error` and offers Reconnect the moment the deletion happens.
 *
 * Signature verification happens in the route, BEFORE this is reached. Never
 * call this on an unverified body: it is a write, triggered by an
 * unauthenticated request, keyed entirely on values the body supplies.
 *
 * ## Deleting a connection from Fretik fires this too
 *
 * Our own `deleteExternalAppConnection` calls `nango.deleteConnection(...)`,
 * so a user removing a connection here produces the same event. That is
 * harmless in both orderings, and neither needs a flag: our row is already
 * gone when the webhook lands (the update matches nothing), or the webhook
 * wins the race and marks a row we delete moments later. What it must not do
 * is fail — hence `markConnectionAsError` staying the no-op-on-miss it
 * already was for the lazy path.
 *
 * ## A disabled connection stays disabled
 *
 * `markConnectionAsError` skips rows the team turned off, and that guard
 * holds here: a team that disabled a connection said they do not want it
 * acting, and flipping it to `error` would hand them a Reconnect prompt for
 * something they deliberately parked. It will be marked on its first use
 * after being re-enabled, by the lazy path.
 */
export const handleNangoWebhook = async (
  body: unknown,
): Promise<NangoWebhookDecision> => {
  const decision = decideNangoWebhook(body);
  if (decision.action === "ignored") return decision;

  await markConnectionAsError({
    nangoConnectionId: decision.nangoConnectionId,
    nangoProviderConfigKey: decision.nangoProviderConfigKey,
    reason: decision.reason,
  });
  return decision;
};
