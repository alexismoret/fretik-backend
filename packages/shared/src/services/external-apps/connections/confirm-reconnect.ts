import { eq } from "drizzle-orm";
import db from "../../../db";
import {
  externalAppConnections,
  type ExternalAppConnection,
} from "../../../db/schema";
import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { extractNangoErrorDetails } from "../../../lib/external-apps/extract-nango-error";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";
import { invalidateConnectionCaches } from "./epoch";
import { getConnectionForCaller } from "./get-by-id";
import { requireNangoRef } from "./nango-ref";

/**
 * Finalise a reconnect started by `createReconnectSession`. Called after
 * Nango Connect UI (or headless `nango.auth(...)`) fires the `connect`
 * event on the frontend.
 *
 * Behaviour:
 *  1. Re-check caller can see the row (defence against a hostile client
 *     trying to confirm someone else's reconnect).
 *  2. Verify the Nango connection actually exists post-reconnect — the
 *     credentials were refreshed by Nango and we want to fail loud if
 *     anything is off.
 *  3. Flip `status` back to `active` and clear `lastErrorMessage` —
 *     UNLESS the row was `disabled` before the reconnect, in which case
 *     we leave it `disabled` (user intent first; the Nango credentials
 *     are still refreshed, the row stays off until the user explicitly
 *     re-enables it from the settings UI).
 *
 * The row's `id`, `displayName`, `options`, `createdByUserId`,
 * `createdAt` are preserved by design — that's the whole point of the
 * reconnect flow vs. a delete+recreate.
 */
export const confirmReconnect = async (params: {
  connectionId: string;
  teamId: string;
  userId: string;
}): Promise<ExternalAppConnection> => {
  const current = await getConnectionForCaller(
    params.connectionId,
    params.teamId,
    params.userId,
  );

  const provider = getProvider(current.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${current.providerKey}`,
    });
  }

  const { nangoProviderConfigKey, nangoConnectionId } =
    requireNangoRef(current);
  const nango = getNangoClient();
  try {
    await nango.getConnection(nangoProviderConfigKey, nangoConnectionId);
  } catch (error) {
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: "Failed to verify the reconnected Nango connection",
      details: extractNangoErrorDetails(error),
    });
  }

  // Respect user intent: a manually-disabled connection stays disabled.
  // The credentials are still refreshed in Nango — the row just stays
  // off until the user flips it back to `active` from the settings UI.
  if (current.status === "disabled") {
    return current;
  }

  const [row] = await db
    .update(externalAppConnections)
    .set({
      status: "active",
      lastErrorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(externalAppConnections.id, params.connectionId))
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to update connection after reconnect",
    });
  }
  // The id survived but the credentials behind it did not: anything cached
  // against this connection may have come from the account it just replaced.
  await invalidateConnectionCaches({ connection: row, purgeAnswers: true });
  return row;
};
