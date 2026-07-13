import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { buildIntegrationsConfigDefaults } from "../../../lib/external-apps/build-integrations-config-defaults";
import { extractNangoErrorDetails } from "../../../lib/external-apps/extract-nango-error";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";
import {
  MCP_CUSTOM_API_KEY_PROVIDER_KEY,
  MCP_CUSTOM_BASIC_PROVIDER_KEY,
  MCP_GENERIC_PROVIDER_KEY,
} from "../mcp/catalog";

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
  /**
   * When true, the session forwards `prompt=consent` to the OAuth provider
   * so a tenant admin can grant the requested scopes org-wide (Microsoft
   * Entra ID, Google Workspace). Ignored for providers whose manifest does
   * not set `requiresAdminConsent`.
   *
   * On Microsoft Identity Platform v2 (the endpoint Nango's `microsoft`
   * alias uses) `prompt=admin_consent` is invalid (AADSTS901001). The
   * documented values are `login | none | consent | select_account`; using
   * `consent` together with the `.default` scope triggers the admin
   * consent UI when the signing-in user is an admin of the tenant (they
   * see a "Consent on behalf of your organization" checkbox). For a
   * non-admin the same flow falls back to user-level consent, which fails
   * for admin-only scopes (AADSTS65001 / 90094) — caught upstream and
   * surfaced via the friendly alert.
   * Ref: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
   */
  adminConsent?: boolean;
  /**
   * For `mcp-generic` only: the server URL the caller already resolved (from
   * the discovery hub or a custom entry). Pre-seeded into the Connect session's
   * `connection_config.mcp_server_url` so Nango's Connect UI does not re-ask the
   * user for a URL they already picked. Ignored for every other provider.
   */
  mcpServerUrl?: string;
}): Promise<{ token: string; connectLink: string; expiresAt: string }> => {
  const provider = getProvider(params.providerKey);

  // MCP connect flows that go through a Nango Connect session / headless auth:
  // custom OAuth (`mcp-generic`, DCR) opens the Connect UI; custom api-key /
  // basic (`mcp-custom-{key,basic}`) run a headless `nango.auth` against the
  // shared vault integration. A no-auth server (`mcp-custom-none`) never mints
  // a session — it falls through to the 404.
  const needsMcpSession =
    provider === undefined &&
    (params.providerKey === MCP_GENERIC_PROVIDER_KEY ||
      params.providerKey === MCP_CUSTOM_API_KEY_PROVIDER_KEY ||
      params.providerKey === MCP_CUSTOM_BASIC_PROVIDER_KEY);
  if (needsMcpSession) {
    const nango = getNangoClient();
    // Pre-fill the server URL so Connect UI never re-asks for a URL the user
    // already chose in the hub. Only `mcp-generic` collects a URL in Connect
    // UI (the api-key / basic flows collect it in Fretik's own form).
    const mcpConfigDefaults =
      params.providerKey === MCP_GENERIC_PROVIDER_KEY &&
      params.mcpServerUrl !== undefined &&
      params.mcpServerUrl !== ""
        ? {
            [MCP_GENERIC_PROVIDER_KEY]: {
              connection_config: { mcp_server_url: params.mcpServerUrl },
            },
          }
        : undefined;
    try {
      const session = await nango.createConnectSession({
        allowed_integrations: [params.providerKey],
        tags: {
          team_id: params.teamId,
          user_id: params.userId,
          user_email: params.userEmail,
        },
        ...(mcpConfigDefaults
          ? { integrations_config_defaults: mcpConfigDefaults }
          : {}),
      });
      return {
        token: session.data.token,
        connectLink: session.data.connect_link,
        expiresAt: session.data.expires_at,
      };
    } catch (error) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
        message: `Nango refused the Connect session for "${params.providerKey}". Make sure the MCP integration is created in the Nango admin dashboard.`,
        details: extractNangoErrorDetails(error),
      });
    }
  }

  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${params.providerKey}`,
    });
  }

  const nango = getNangoClient();
  const integrationsConfigDefaults = buildIntegrationsConfigDefaults({
    providerKey: params.providerKey,
    forcePromptConsent: params.adminConsent === true,
  });

  let session;
  try {
    session = await nango.createConnectSession({
      allowed_integrations: [provider.manifest.nangoProviderConfigKey],
      tags: {
        team_id: params.teamId,
        user_id: params.userId,
        user_email: params.userEmail,
      },
      ...(integrationsConfigDefaults
        ? { integrations_config_defaults: integrationsConfigDefaults }
        : {}),
    });
  } catch (error) {
    // The Nango SDK uses Axios; a non-2xx surfaces as an AxiosError
    // with `response.data` carrying Nango's JSON error envelope. The
    // most common cause in dev is an `allowed_integrations` reference
    // to an integration that hasn't been created in the Nango admin
    // dashboard yet — surface that as a clear, user-actionable error
    // instead of leaking the raw Axios stack to the global handler.
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: `Nango refused the Connect session for "${provider.manifest.nangoProviderConfigKey}". Make sure the integration is created in the Nango admin dashboard with the OAuth scopes from the provider manifest.`,
      details: extractNangoErrorDetails(error),
    });
  }

  return {
    token: session.data.token,
    connectLink: session.data.connect_link,
    expiresAt: session.data.expires_at,
  };
};
