import { eq } from "drizzle-orm";
import db from "../../../db";
import { externalAppConnections } from "../../../db/schema";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { getConnectionForCaller } from "./get-by-id";

/**
 * Delete a connection: revoke in Nango (best-effort) then drop the DB row.
 *
 * The Nango call is wrapped in a try/catch so a 404 (connection already
 * gone server-side) or a transient network error never blocks the user
 * from removing the row from their settings. The DB delete cascades to
 * any pending tool_approval_requests through the FK (set null), keeping
 * them visible in audit.
 */
export const deleteConnection = async (params: {
  id: string;
  teamId: string;
  userId: string;
}): Promise<void> => {
  const conn = await getConnectionForCaller(
    params.id,
    params.teamId,
    params.userId,
  );

  try {
    const nango = getNangoClient();
    await nango.deleteConnection(
      conn.nangoProviderConfigKey,
      conn.nangoConnectionId,
    );
  } catch (error) {
    // Log but keep going — the user wants the connection gone from
    // Fretik regardless of whether Nango cleanup succeeded.
    console.warn(
      `[external-apps] Failed to delete Nango connection ${conn.nangoConnectionId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  await db
    .delete(externalAppConnections)
    .where(eq(externalAppConnections.id, params.id));
};
