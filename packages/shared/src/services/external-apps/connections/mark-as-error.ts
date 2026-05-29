import { and, eq, ne } from "drizzle-orm";
import db from "../../../db";
import { externalAppConnections } from "../../../db/schema";

/**
 * Flip a connection's `status` to `error` and persist the cause in
 * `lastErrorMessage`, so the frontend can render the "Reconnect" CTA.
 *
 * Called from the proxy/custom-handler wrappers when `isAuthFailure`
 * matches a thrown Nango error. Detection is lazy — Nango free
 * self-hosted does not emit webhooks (see the comment on the status
 * enum in `db/schema/external-apps.ts`), so the only signal we get
 * is an action throwing.
 *
 * Lookup is by `(nangoConnectionId, nangoProviderConfigKey)` — covered
 * by the `uniq_eac_nango` unique index. One Nango connection maps to
 * exactly one row, so this is unambiguous.
 *
 * Guard `status != 'disabled'`: a user who manually disabled a
 * connection should not see it silently flip to `error` on the next
 * background call. Respect their intent.
 *
 * Returns silently on no-op (connection already in error, or disabled,
 * or row missing). Callers MUST `.catch(() => undefined)` this — a
 * DB write failure must never mask the original auth error that
 * needs to surface to the agent/sandbox.
 */
export const markConnectionAsError = async (params: {
  nangoConnectionId: string;
  nangoProviderConfigKey: string;
  reason: string;
}): Promise<void> => {
  await db
    .update(externalAppConnections)
    .set({
      status: "error",
      lastErrorMessage: params.reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(externalAppConnections.nangoConnectionId, params.nangoConnectionId),
        eq(
          externalAppConnections.nangoProviderConfigKey,
          params.nangoProviderConfigKey,
        ),
        ne(externalAppConnections.status, "disabled"),
      ),
    );
};
