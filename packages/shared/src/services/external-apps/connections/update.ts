import { eq } from "drizzle-orm";
import { z } from "zod";
import db from "../../../db";
import {
  type ExternalAppConnection,
  type ExternalAppConnectionStatus,
  externalAppConnections,
} from "../../../db/schema";
import { buildConnectionOptionsZod } from "../../../external-apps/connection-options-validator";
import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { getConnectionForCaller } from "./get-by-id";

/**
 * Rename a connection, flip its status (`active` ↔ `disabled`) or update
 * its `options`. Only the original creator or members with team-wide
 * access can update — `getConnectionForCaller` already enforces team +
 * user-scope visibility, so anyone who can see the connection can update
 * it.
 *
 * Status `error` is set by the dispatcher itself on a Nango 401/403, not
 * by users — it's accepted here for completeness (admins flipping back
 * to `active` after a manual recovery).
 *
 * `options` is treated as a partial patch: provided keys overwrite the
 * existing JSONB, omitted keys are preserved. The resulting merged object
 * is then re-validated against the provider's `connectionOptions`
 * descriptor as a whole, so partial updates can never leave the
 * connection in an invalid state.
 */
export const updateConnection = async (params: {
  id: string;
  teamId: string;
  userId: string;
  displayName?: string;
  status?: ExternalAppConnectionStatus;
  options?: Record<string, unknown>;
}): Promise<ExternalAppConnection> => {
  const current = await getConnectionForCaller(
    params.id,
    params.teamId,
    params.userId,
  );

  const patch: Partial<ExternalAppConnection> = { updatedAt: new Date() };
  if (params.displayName !== undefined) patch.displayName = params.displayName;
  if (params.status !== undefined) {
    patch.status = params.status;
    if (params.status !== "error") patch.lastErrorMessage = null;
  }

  if (params.options !== undefined) {
    const provider = getProvider(current.providerKey);
    if (provider === undefined) {
      return throwHttpError(404, {
        code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
        message: `Unknown provider: ${current.providerKey}`,
      });
    }
    if (provider.manifest.connectionOptions === undefined) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
        message: `Provider ${current.providerKey} does not accept connection options.`,
      });
    }
    const merged: Record<string, unknown> = {
      ...(current.options ?? {}),
      ...params.options,
    };
    const schema = buildConnectionOptionsZod(
      provider.manifest.connectionOptions,
    );
    const parsed = schema.safeParse(merged);
    if (!parsed.success) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
        message: "Invalid connection options",
        details: z.prettifyError(parsed.error),
      });
    }
    patch.options = parsed.data;
  }

  const [row] = await db
    .update(externalAppConnections)
    .set(patch)
    .where(eq(externalAppConnections.id, params.id))
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to update connection",
    });
  }
  return row;
};
