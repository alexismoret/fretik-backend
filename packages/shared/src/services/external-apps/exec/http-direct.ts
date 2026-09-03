import { isRecord } from "../../../external-apps/json-access";
import type {
  HttpDirectTransport,
  HttpMethod,
  ProviderManifest,
} from "../../../external-apps/manifest-schema";
import { normalizeNangoCredentials } from "../../../external-apps/normalize-nango-credentials";
import {
  isAuthFailure,
  isHttpDirectCredentialFailure,
} from "../../../lib/external-apps/detect-auth-failure";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { clearConnectionErrorStatus } from "../connections/clear-error-status";
import { markConnectionAsError } from "../connections/mark-as-error";

/**
 * Executor for `http-direct` transport providers — HTTP REST APIs that are
 * NOT on Nango's catalog. Same declarative contract as `nango-proxy`
 * (manifest endpoint + params with `in: path|query|body` + optional
 * request/response mappers) — `buildRequest()` is reused upstream — but
 * the egress is our own `fetch()` instead of `nango.proxy(...)`.
 *
 * Credentials live in Nango (`private-api-key` template), fetched on
 * demand via `nango.getConnection(...)` — same single-source-of-truth as
 * `custom-handler`. The manifest's transport block declares HOW to project
 * the stored fields onto every request (`auth` + `extraHeaders` with
 * `credentials.<key>` / `connection_config.<key>` dot paths).
 */

export interface HttpDirectCall {
  manifest: ProviderManifest;
  transport: HttpDirectTransport;
  providerConfigKey: string;
  connectionId: string;
  method: HttpMethod;
  /** Path part — base URL comes from `transport.baseUrl`. */
  endpoint: string;
  query?: Record<string, string>;
  body?: unknown;
}

/**
 * Read one `credentials.<key>` / `connection_config.<key>` dot path off the
 * stored connection. Returns `undefined` when the value is absent or empty
 * — callers decide whether that is fatal (the auth credential) or means
 * "skip this header" (an `optional` extra header).
 */
const resolveSource = (
  source: string,
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): string | undefined => {
  const dotIdx = source.indexOf(".");
  if (dotIdx <= 0) {
    throw new Error(`http-direct: invalid source path "${source}"`);
  }
  const scope = source.slice(0, dotIdx);
  const key = source.slice(dotIdx + 1);
  const bag =
    scope === "credentials"
      ? credentials
      : scope === "connection_config"
        ? connectionConfig
        : null;
  if (bag === null) {
    throw new Error(
      `http-direct: source scope must be "credentials" or "connection_config" (got "${scope}")`,
    );
  }
  const value = bag[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  throw new Error(
    `http-direct: value at "${source}" must be a string, number or boolean (got ${typeof value})`,
  );
};

/**
 * Project the stored connection onto the auth + extra headers a
 * `http-direct` transport declares. Pure, and exported so the rule that
 * decides whether a call is even attempted is testable without a Nango
 * double: the credential is mandatory, an extra header is mandatory unless
 * it declares `optional`, and an optional one with nothing behind it is
 * omitted rather than sent empty.
 *
 * Returns the header map plus any auth value that belongs in the query
 * string (`auth.kind === "query"`).
 */
export const projectHttpDirectAuth = (
  transport: HttpDirectTransport,
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): { headers: Record<string, string>; query: Record<string, string> } => {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};

  const authValue = resolveSource(
    transport.auth.source,
    credentials,
    connectionConfig,
  );
  if (authValue === undefined) {
    throw new Error(
      `http-direct: missing required value at "${transport.auth.source}" on this connection`,
    );
  }
  const authProjected =
    transport.auth.scheme !== undefined
      ? `${transport.auth.scheme}${authValue}`
      : authValue;
  if (transport.auth.kind === "header") {
    headers[transport.auth.name] = authProjected;
  } else {
    query[transport.auth.name] = authProjected;
  }

  for (const extra of transport.extraHeaders ?? []) {
    const value = resolveSource(extra.source, credentials, connectionConfig);
    if (value === undefined) {
      if (extra.optional === true) continue;
      throw new Error(
        `http-direct: missing required value at "${extra.source}" on this connection`,
      );
    }
    headers[extra.name] = value;
  }

  return { headers, query };
};

const buildUrl = (
  baseUrl: string,
  path: string,
  query: Record<string, string> | undefined,
): string => {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${baseUrl}/`);
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return url.toString();
};

const previewBody = (raw: string): string =>
  raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;

export const callHttpDirect = async (
  call: HttpDirectCall,
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
    ? connection.credentials
    : {};
  const rawConnectionConfig: Record<string, unknown> = isRecord(
    connection.connection_config,
  )
    ? connection.connection_config
    : {};
  // Reverse `nangoKey` rename so transport's `auth.source` /
  // `extraHeaders.source` paths address the canonical snake_case keys
  // declared in the manifest (e.g. `credentials.api_key`) regardless of
  // how Nango stored them (`credentials.apiKey` for `private-api-key`).
  const { credentials, connection_config: connectionConfig } =
    normalizeNangoCredentials(
      call.manifest,
      rawCredentials,
      rawConnectionConfig,
    );

  const projected = projectHttpDirectAuth(
    call.transport,
    credentials,
    connectionConfig,
  );
  const headers: Record<string, string> = projected.headers;
  const query: Record<string, string> = {
    ...(call.query ?? {}),
    ...projected.query,
  };

  const url = buildUrl(
    call.transport.baseUrl,
    call.endpoint,
    Object.keys(query).length > 0 ? query : undefined,
  );

  const init: RequestInit = { method: call.method, headers };
  if (call.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(call.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new Error(
      `EXTERNAL_APP_HTTP_FAILED: ${call.method} ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (res.status === 204) {
    // 2xx — auto-heal a connection that was previously flagged in error
    // by a transient/business-rule 4xx. No-op on healthy connections.
    void clearConnectionErrorStatus({
      nangoConnectionId: call.connectionId,
      nangoProviderConfigKey: call.providerConfigKey,
    }).catch(() => undefined);
    return null;
  }

  const rawText = await res.text();

  if (!res.ok) {
    const error = new Error(
      `EXTERNAL_APP_HTTP_FAILED: ${call.method} ${url} → ${res.status.toString()}: ${previewBody(rawText)}`,
    );
    // Two independent classifiers — both must miss for the connection to
    // stay `active`:
    //  1. `isAuthFailure(error)` — message-pattern match against the
    //     thrown Error (covers Nango wraps + OAuth provider passthrough).
    //  2. `isHttpDirectCredentialFailure(status, body)` — http-direct
    //     specific. 401 is always a credential failure; 403 only when
    //     the body explicitly says so. A 403 with no auth-related body
    //     (e.g. Shiptify's "User is not shipper" — a role mismatch the
    //     agent triggered) is a business rule, NOT a dead API key, and
    //     must NOT flip the connection to `error`.
    const detectedFromError = isAuthFailure(error);
    const detectedFromHttp = isHttpDirectCredentialFailure(res.status, rawText);
    if (detectedFromError.matched || detectedFromHttp.matched) {
      await markConnectionAsError({
        nangoConnectionId: call.connectionId,
        nangoProviderConfigKey: call.providerConfigKey,
        reason: detectedFromError.matched
          ? detectedFromError.reason
          : detectedFromHttp.reason,
      }).catch(() => undefined);
    }
    throw error;
  }

  // 2xx — auto-heal (see comment on the 204 branch above).
  void clearConnectionErrorStatus({
    nangoConnectionId: call.connectionId,
    nangoProviderConfigKey: call.providerConfigKey,
  }).catch(() => undefined);

  if (rawText.length === 0) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    // Non-JSON 2xx (rare — usually a redirect-style attachment URL).
    return rawText;
  }
};
