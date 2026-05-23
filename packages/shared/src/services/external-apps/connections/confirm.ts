import db from "../../../db";
import {
  type ExternalAppConnection,
  externalAppConnections,
} from "../../../db/schema";
import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";

/**
 * Confirm a connection created via Connect UI. Called by the API after
 * the frontend fires `onEvent({ type: 'connect' })`.
 *
 * Verifies the connection actually exists in Nango (sanity check + guards
 * against a hostile client sending fake IDs), then upserts our DB row.
 * Nango is the source of truth for the auth state; this row is the
 * Fretik-side scope, display name and audit.
 */
export const confirmConnection = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  scope: "team" | "user";
  providerKey: string;
  displayName: string;
  nangoConnectionId: string;
}): Promise<ExternalAppConnection> => {
  const provider = getProvider(params.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${params.providerKey}`,
    });
  }

  const nango = getNangoClient();
  try {
    await nango.getConnection(
      provider.manifest.nangoProviderConfigKey,
      params.nangoConnectionId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: "Failed to verify the Nango connection",
      details: message,
    });
  }

  const [row] = await db
    .insert(externalAppConnections)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.scope === "user" ? params.userId : null,
      providerKey: params.providerKey,
      displayName: params.displayName,
      nangoConnectionId: params.nangoConnectionId,
      nangoProviderConfigKey: provider.manifest.nangoProviderConfigKey,
      createdByUserId: params.userId,
    })
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to insert connection row",
    });
  }
  return row;
};
