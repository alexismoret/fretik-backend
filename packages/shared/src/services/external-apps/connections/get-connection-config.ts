import { isRecord } from "../../../external-apps/json-access";
import { normalizeNangoCredentials } from "../../../external-apps/normalize-nango-credentials";
import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { extractNangoErrorDetails } from "../../../lib/external-apps/extract-nango-error";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";
import { getConnectionForCaller } from "./get-by-id";
import { requireNangoRef } from "./nango-ref";

/**
 * Fetch the non-sensitive `connection_config` of a custom-handler
 * connection so the frontend can pre-fill the credentials form on
 * reconnect. Only fields declared with `target: 'connection_config'`
 * in the provider's `credentialsForm` descriptor are returned — fields
 * with `target: 'credentials'` (username, password, API keys) NEVER
 * leave Nango, even if Nango returns them.
 *
 * The filter is based on the manifest descriptor, NOT on what Nango
 * happens to return — defence in depth. Adding a sensitive field to a
 * provider manifest in the future automatically keeps it out of this
 * endpoint, no code change required.
 *
 * 400 for OAuth providers: there's nothing to pre-fill (no form), the
 * frontend takes a different code path (one-click Connect UI).
 */
export const getConnectionConfigForReconnect = async (params: {
  connectionId: string;
  teamId: string;
  userId: string;
}): Promise<Record<string, unknown>> => {
  const row = await getConnectionForCaller(
    params.connectionId,
    params.teamId,
    params.userId,
  );

  const provider = getProvider(row.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${row.providerKey}`,
    });
  }
  // Reconnect form pre-fill is only meaningful for descriptor-driven
  // transports (`custom-handler`, `http-direct`). OAuth (`nango-proxy`)
  // has no form to pre-fill — the frontend takes the Connect UI path.
  if (provider.manifest.transport.kind === "nango-proxy") {
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NOT_CUSTOM_HANDLER,
      message: `Provider "${row.providerKey}" uses OAuth — no credentials form to pre-fill.`,
    });
  }
  if (provider.manifest.credentialsForm === undefined) {
    // Descriptor-driven provider without a credentialsForm shouldn't
    // happen in practice (the registry rejects it), but defend anyway.
    return {};
  }

  const { nangoProviderConfigKey, nangoConnectionId } = requireNangoRef(row);
  const nango = getNangoClient();
  let nangoConnection;
  try {
    nangoConnection = await nango.getConnection(
      nangoProviderConfigKey,
      nangoConnectionId,
    );
  } catch (error) {
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: "Failed to fetch the Nango connection",
      details: extractNangoErrorDetails(error),
    });
  }

  const rawCredentials = isRecord(nangoConnection.credentials)
    ? (nangoConnection.credentials as Record<string, unknown>)
    : {};
  const rawConnectionConfig = isRecord(nangoConnection.connection_config)
    ? (nangoConnection.connection_config as Record<string, unknown>)
    : {};
  // Reverse `nangoKey` rename before filtering: the descriptor's
  // `field.key` is the canonical name our consumers use, but Nango may
  // have stored under a renamed key (`apiKey` vs `api_key`).
  const { connection_config: connectionConfig } = normalizeNangoCredentials(
    provider.manifest,
    rawCredentials,
    rawConnectionConfig,
  );

  // Strict descriptor-driven filter. Only fields the manifest declared
  // with `target: 'connection_config'` are returned. A `target:
  // 'credentials'` field (password, API key) is dropped even if Nango
  // surfaced it.
  const allowedKeys = new Set<string>();
  for (const field of provider.manifest.credentialsForm.fields) {
    if (field.target === "connection_config") allowedKeys.add(field.key);
  }

  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (connectionConfig[key] !== undefined) {
      out[key] = connectionConfig[key];
    }
  }
  return out;
};
