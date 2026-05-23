import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";

/**
 * Mint a Nango Connect Session for the frontend to open Connect UI with.
 *
 * The session is short-lived (30 min per Nango). Tenant context is passed
 * as `tags` — copied onto the created connection (visible in the Nango
 * dashboard and in auth webhooks where available). The deprecated
 * `end_user` / `organization` top-level fields are not used.
 *
 * Tag policy — only the values we'd actually use to find the connection
 * back from Nango (team scope + the human behind it). Provider key /
 * display name are not in tags: the provider is already conveyed by the
 * connection's `providerConfigKey`, and the display name only lives on
 * the Fretik side.
 */
export const createConnectSession = async (params: {
  teamId: string;
  userId: string;
  userEmail: string;
  providerKey: string;
}): Promise<{ token: string; connectLink: string; expiresAt: string }> => {
  const provider = getProvider(params.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${params.providerKey}`,
    });
  }

  const nango = getNangoClient();
  const session = await nango.createConnectSession({
    allowed_integrations: [provider.manifest.nangoProviderConfigKey],
    tags: {
      team_id: params.teamId,
      user_id: params.userId,
      user_email: params.userEmail,
    },
  });

  return {
    token: session.data.token,
    connectLink: session.data.connect_link,
    expiresAt: session.data.expires_at,
  };
};
