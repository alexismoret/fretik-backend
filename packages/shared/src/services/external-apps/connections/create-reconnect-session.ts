import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { buildIntegrationsConfigDefaults } from "../../../lib/external-apps/build-integrations-config-defaults";
import { extractNangoErrorDetails } from "../../../lib/external-apps/extract-nango-error";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";
import { getConnectionForCaller } from "./get-by-id";
import { requireNangoRef } from "./nango-ref";

/**
 * Mint a Nango Connect Session bound to an EXISTING connection so the
 * frontend can re-open Connect UI without losing `id`, `displayName`,
 * `options` or audit trail (`createdByUserId`, `createdAt`).
 *
 * Mirrors `createConnectSession` but hits Nango's `/connect/sessions/reconnect`
 * endpoint, which preserves the `connection_id` instead of generating a
 * fresh one. Works for both `nango-proxy` (OAuth) and `custom-handler`
 * (headless `nango.auth(...)`) transports — Nango accepts the reconnect
 * call for both and the frontend branches on transport to choose the
 * right Connect UI mode.
 *
 * For OAuth providers, `prompt=consent` is forced unconditionally —
 * the user explicitly clicked "Reconnect", so we want them to see the
 * provider's consent screen (chance to re-grant admin scopes if the
 * original failure was a scope revocation). Ignored by the manifest's
 * gate inside `buildIntegrationsConfigDefaults` when the provider does
 * not set `requiresAdminConsent`.
 */
export const createReconnectSession = async (params: {
  connectionId: string;
  teamId: string;
  userId: string;
  userEmail: string;
}): Promise<{ token: string; connectLink: string; expiresAt: string }> => {
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

  const { nangoProviderConfigKey, nangoConnectionId } = requireNangoRef(row);
  const nango = getNangoClient();
  const integrationsConfigDefaults = buildIntegrationsConfigDefaults({
    providerKey: row.providerKey,
    forcePromptConsent: true,
  });

  let session;
  try {
    session = await nango.createReconnectSession({
      connection_id: nangoConnectionId,
      integration_id: nangoProviderConfigKey,
      ...(integrationsConfigDefaults
        ? { integrations_config_defaults: integrationsConfigDefaults }
        : {}),
    });
  } catch (error) {
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: `Nango refused the reconnect session for "${nangoProviderConfigKey}".`,
      details: extractNangoErrorDetails(error),
    });
  }

  return {
    token: session.data.token,
    connectLink: session.data.connect_link,
    expiresAt: session.data.expires_at,
  };
};
