import { getProvider } from "../../external-apps/registry";

/**
 * Build the `integrations_config_defaults` payload for Nango Connect
 * session calls (both `createConnectSession` and `createReconnectSession`).
 *
 * Today only carries `authorization_params.prompt = "consent"` when the
 * caller asks for it AND the manifest opts in. Centralised so the
 * create + reconnect flows agree on the shape — and so future params
 * (additional scopes, audience, …) land in one place.
 *
 * On Microsoft Identity Platform v2, `prompt=consent` with the `.default`
 * scope is what triggers the admin-consent UI for a signing-in admin.
 * `prompt=admin_consent` is invalid (AADSTS901001) — do not use it.
 * Returns `undefined` (not `{}`) when no override is needed: Nango
 * distinguishes "omitted" from "explicitly empty override".
 */
export const buildIntegrationsConfigDefaults = (params: {
  providerKey: string;
  /** When true, append `authorization_params.prompt=consent` if the provider opts in. */
  forcePromptConsent?: boolean;
}):
  | Record<string, { authorization_params?: Record<string, string> }>
  | undefined => {
  const provider = getProvider(params.providerKey);
  if (provider === undefined) return undefined;

  const wantsConsent =
    params.forcePromptConsent === true &&
    provider.manifest.requiresAdminConsent === true;
  if (!wantsConsent) return undefined;

  return {
    [provider.manifest.nangoProviderConfigKey]: {
      authorization_params: { prompt: "consent" },
    },
  };
};
