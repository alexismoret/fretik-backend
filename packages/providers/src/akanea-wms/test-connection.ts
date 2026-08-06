import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";
import { UnsafeUrlError } from "@fretik/shared/lib/net/assert-public-https-url";
import { AkaneaError, parseAkaneaConfig, withToken } from "./client";

/**
 * Validate a Xtent login by leasing a token and handing it straight back.
 * `withToken` releases the seat in its `finally`, so a test never leaves a
 * license held.
 *
 * The credentials are not in Nango yet when the user presses "Test
 * connection" — they come from the form, exactly as `parseAkaneaConfig`
 * will later read them from the stored connection.
 */
export const testAkaneaWmsCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  try {
    const config = parseAkaneaConfig(credentials, connection_config);
    await withToken(config, async () => undefined);
    return { ok: true };
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return { ok: false, scope: "base_url", message: error.message };
    }
    if (error instanceof AkaneaError) {
      return { ok: false, scope: error.scope, message: error.message };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
};
