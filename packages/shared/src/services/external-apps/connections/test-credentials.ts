import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";

/**
 * Validate user-supplied credentials against a `custom-handler` provider.
 *
 * Wired to `POST /external-apps/connections/test-credentials` — invoked
 * by the descriptor-driven credentials form on the frontend (the "Test
 * connection" button) AND used post-`nango.getConnection()` inside
 * `confirmConnection` as a defense against silent failures.
 *
 * Provider-agnostic: it dispatches to whatever `testCredentials` the
 * provider registered. For `nango-proxy` providers (Outlook), there's
 * no per-credential test — the OAuth grant itself is the validation,
 * so this route 400s instead.
 */
export const testConnectionCredentials = async (params: {
  providerKey: string;
  credentials: Record<string, unknown>;
  connectionConfig: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; scope?: string; message: string }> => {
  const provider = getProvider(params.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${params.providerKey}`,
    });
  }
  if (provider.testCredentials === undefined) {
    return throwHttpError(400, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Provider ${params.providerKey} does not support credential testing`,
    });
  }

  return provider.testCredentials({
    credentials: params.credentials,
    connection_config: params.connectionConfig,
  });
};
