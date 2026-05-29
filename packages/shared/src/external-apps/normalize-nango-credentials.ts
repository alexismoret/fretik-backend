import type { ProviderManifest } from "./manifest-schema";

/**
 * Reverse-map a Nango-stored credentials / connection_config pair into the
 * snake_case shape our handlers expect. Symmetric to the forward mapping
 * done by the frontend (`AddConnectionModal.onConnect` /
 * `useReconnectConnection.completeCustomHandlerReconnect`).
 *
 * Why: some Nango credential templates require specific wire shapes
 * (`private-api-key` expects `credentials.apiKey` camelCase) that don't
 * match our codebase's snake_case convention. The manifest's
 * `credentialsForm.fields[i].nangoKey` declares the Nango-side name; we
 * project it back to `field.key` here so every downstream consumer
 * (testCredentials, http-direct executor, get-connection-config) reads
 * the same canonical shape regardless of provider.
 *
 * Keys not declared by any field pass through verbatim — defends against
 * Nango adding tokens / metadata the manifest doesn't enumerate (refresh
 * tokens, expires_at, …).
 */
export const normalizeNangoCredentials = (
  manifest: ProviderManifest,
  rawCredentials: Record<string, unknown>,
  rawConnectionConfig: Record<string, unknown>,
): {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
} => {
  const credsRename = new Map<string, string>();
  const cfgRename = new Map<string, string>();
  for (const field of manifest.credentialsForm?.fields ?? []) {
    const nangoKey = field.nangoKey;
    if (nangoKey === undefined || nangoKey === field.key) continue;
    if (field.target === "credentials") {
      credsRename.set(nangoKey, field.key);
    } else {
      cfgRename.set(nangoKey, field.key);
    }
  }

  if (credsRename.size === 0 && cfgRename.size === 0) {
    return {
      credentials: rawCredentials,
      connection_config: rawConnectionConfig,
    };
  }

  const credentials: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawCredentials)) {
    credentials[credsRename.get(k) ?? k] = v;
  }
  const connection_config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawConnectionConfig)) {
    connection_config[cfgRename.get(k) ?? k] = v;
  }
  return { credentials, connection_config };
};
