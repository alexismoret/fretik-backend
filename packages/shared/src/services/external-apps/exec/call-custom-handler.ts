import { isRecord } from "../../../external-apps/json-access";
import type { ProviderManifest } from "../../../external-apps/manifest-schema";
import { normalizeNangoCredentials } from "../../../external-apps/normalize-nango-credentials";
import type { ProviderHandler } from "../../../external-apps/provider-types";
import { isAuthFailure } from "../../../lib/external-apps/detect-auth-failure";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { markConnectionAsError } from "../connections/mark-as-error";

/**
 * Executor for `custom-handler` transport providers (IMAP/SMTP, future
 * SDK-only / private-OpenAPI providers).
 *
 * Where the `nango-proxy` path lets Nango inject the token and forward
 * the HTTP request, here we DO need the credentials in our own runtime
 * to feed them to a non-HTTP protocol client (IMAP via `imapflow`, SMTP
 * via `nodemailer`, …) or to an SDK with its own request shape.
 *
 * Credentials never live in our DB — they are fetched on-demand from
 * Nango (`nango.getConnection(...)`) right before invoking the handler.
 * Nango remains the single source of truth for encrypted credential
 * storage even for non-OAuth providers.
 *
 * Two failure points get the same auth-failure detection as the proxy
 * path:
 *  - `nango.getConnection(...)` — can throw `unknown_connection` or a
 *    `invalid_credentials` (refresh limit exhausted on OAuth-backed
 *    custom handlers).
 *  - the handler itself — IMAP returns AUTHENTICATIONFAILED, SMTP
 *    raises an EAUTH; if `isAuthFailure` matches the thrown error we
 *    mark the connection.
 */

export interface CustomHandlerCall {
  manifest: ProviderManifest;
  providerConfigKey: string;
  connectionId: string;
  handler: ProviderHandler;
  args: Record<string, unknown>;
}

export const callCustomHandler = async (
  call: CustomHandlerCall,
): Promise<unknown> => {
  const nango = getNangoClient();

  let connection;
  try {
    connection = await nango.getConnection(
      call.providerConfigKey,
      call.connectionId,
    );
  } catch (error) {
    const detected = isAuthFailure(error);
    if (detected.matched) {
      await markConnectionAsError({
        nangoConnectionId: call.connectionId,
        nangoProviderConfigKey: call.providerConfigKey,
        reason: detected.reason,
      }).catch(() => undefined);
    }
    throw error;
  }

  const rawCredentials: Record<string, unknown> = isRecord(
    connection.credentials,
  )
    ? (connection.credentials as Record<string, unknown>)
    : {};
  const rawConnectionConfig: Record<string, unknown> = isRecord(
    connection.connection_config,
  )
    ? (connection.connection_config as Record<string, unknown>)
    : {};
  // Reverse `nangoKey` rename — same reason as http-direct: handlers
  // read canonical snake_case keys regardless of how Nango stored them.
  const { credentials, connection_config: connectionConfig } =
    normalizeNangoCredentials(
      call.manifest,
      rawCredentials,
      rawConnectionConfig,
    );

  try {
    return await call.handler(call.args, {
      credentials,
      connection_config: connectionConfig,
    });
  } catch (error) {
    const detected = isAuthFailure(error);
    if (detected.matched) {
      await markConnectionAsError({
        nangoConnectionId: call.connectionId,
        nangoProviderConfigKey: call.providerConfigKey,
        reason: detected.reason,
      }).catch(() => undefined);
    }
    throw error;
  }
};
