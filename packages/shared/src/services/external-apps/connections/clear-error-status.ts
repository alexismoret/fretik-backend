import { and, eq } from "drizzle-orm";
import db from "../../../db";
import { externalAppConnections } from "../../../db/schema";

/**
 * Flip a connection's `status` from `error` back to `active` and clear
 * `lastErrorMessage`, called from the executors after a successful 2xx
 * response. Self-heals connections that were wrongly flagged by a
 * transient or business-rule 4xx — until this fix, an `http-direct`
 * provider like Shiptify could land in `error` on any 403 (e.g. the
 * agent calling a route the account's role does not authorise).
 *
 * The `WHERE status = 'error'` predicate makes this a no-op when the
 * connection is already `active` or `disabled`. Callers fire-and-forget
 * via `.catch(() => undefined)` — the recovery is a UX nicety; a DB
 * write failure must never mask the successful response that just
 * came back.
 *
 * Lookup is by `(nangoConnectionId, nangoProviderConfigKey)` — covered
 * by the `uniq_eac_nango` unique index, same as `markConnectionAsError`.
 */
export const clearConnectionErrorStatus = async (params: {
  nangoConnectionId: string;
  nangoProviderConfigKey: string;
}): Promise<void> => {
  await db
    .update(externalAppConnections)
    .set({
      status: "active",
      lastErrorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(externalAppConnections.nangoConnectionId, params.nangoConnectionId),
        eq(
          externalAppConnections.nangoProviderConfigKey,
          params.nangoProviderConfigKey,
        ),
        eq(externalAppConnections.status, "error"),
      ),
    );
};
