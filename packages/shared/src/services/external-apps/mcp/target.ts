import type { ExternalAppConnection } from "../../../db/schema";
import { isRecord } from "../../../external-apps/json-access";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { assertPublicHttpsUrl } from "../../../lib/net/assert-public-https-url";
import { requireNangoRef } from "../connections/nango-ref";
import type { McpAuthKind } from "./connection-kind";

/**
 * Resolve a connection row into a concrete `{ url, headers }` the direct MCP
 * transport can POST to. Auth is layered per kind: `none` sends nothing,
 * `api-key`/`basic` read the secret from the Nango vault, `nango-oauth` reads
 * the OAuth access token Nango refreshes on demand. Secrets are turned into
 * headers here and never touch our DB or an error message.
 */

/** A ready-to-use MCP endpoint: the URL, auth headers, and remote transport. */
export interface McpTarget {
  url: string;
  headers: Record<string, string>;
  /** `sse` for SSE remotes; absent/`http` for Streamable-HTTP (the default). */
  transportType?: "http" | "sse";
}

/** The connection columns the resolver reads. */
export type McpConnectionTarget = Pick<
  ExternalAppConnection,
  | "id"
  | "providerKey"
  | "displayName"
  | "mcpAuthKind"
  | "mcpServerUrl"
  | "mcpApiKeyHeader"
  | "mcpTransport"
  | "nangoConnectionId"
  | "nangoProviderConfigKey"
>;

/**
 * Resolved auth material, decoupled from where it came from. Turning this into
 * HTTP headers (`buildMcpTarget`) is a pure function — unit-testable without
 * Nango.
 */
export type McpCredential =
  | { scheme: "none" }
  | { scheme: "bearer"; token: string }
  | { scheme: "header"; name: string; value: string }
  | { scheme: "basic"; username: string; password: string };

/** Pure: server URL + resolved credential → the target's URL and headers. */
export const buildMcpTarget = (
  serverUrl: string,
  credential: McpCredential,
  transportType: "http" | "sse" = "http",
): McpTarget => {
  const headers: Record<string, string> = {};
  switch (credential.scheme) {
    case "none":
      break;
    case "bearer":
      headers.Authorization = `Bearer ${credential.token}`;
      break;
    case "header":
      headers[credential.name] = credential.value;
      break;
    case "basic":
      headers.Authorization = `Basic ${btoa(`${credential.username}:${credential.password}`)}`;
      break;
  }
  return { url: serverUrl, headers, transportType };
};

/** Read one string field from a Nango connection's `credentials`. */
const readCredentialField = (
  credentials: unknown,
  field: string,
  displayName: string,
): string => {
  const value = isRecord(credentials) ? credentials[field] : undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `Connection "${displayName}" is missing its "${field}" credential in Nango — reconnect it.`,
    );
  }
  return value;
};

/** Fetch + shape the credential for a connection's auth kind. */
const resolveCredential = async (
  connection: McpConnectionTarget,
  authKind: McpAuthKind,
): Promise<McpCredential> => {
  if (authKind === "none") return { scheme: "none" };
  if (authKind === "oauth-direct") {
    throw new Error(
      `Connection "${connection.displayName}" uses direct OAuth, which is not implemented yet.`,
    );
  }

  const ref = requireNangoRef(connection);
  const nango = getNangoClient();
  const nangoConnection = await nango.getConnection(
    ref.nangoProviderConfigKey,
    ref.nangoConnectionId,
  );
  const credentials = nangoConnection.credentials;

  switch (authKind) {
    case "api-key": {
      // Stored under `credentials.apiKey` (the `private-api-bearer` template).
      const key = readCredentialField(
        credentials,
        "apiKey",
        connection.displayName,
      );
      return connection.mcpApiKeyHeader === null
        ? { scheme: "bearer", token: key }
        : { scheme: "header", name: connection.mcpApiKeyHeader, value: key };
    }
    case "basic": {
      // Stored under `credentials.{username,password}` (`private-api-basic`).
      const username = readCredentialField(
        credentials,
        "username",
        connection.displayName,
      );
      const password = readCredentialField(
        credentials,
        "password",
        connection.displayName,
      );
      return { scheme: "basic", username, password };
    }
    case "nango-oauth": {
      // OAuth access token Nango stores + refreshes for MCP_OAUTH2 connections.
      const token = readCredentialField(
        credentials,
        "access_token",
        connection.displayName,
      );
      return { scheme: "bearer", token };
    }
    default:
      throw new Error(`Unhandled MCP auth kind: ${String(authKind)}`);
  }
};

/**
 * Row → target: validate the URL (SSRF guard, on EVERY call) and resolve the
 * auth headers. Throws a descriptive Error (never containing the secret) on a
 * non-MCP row, a pre-migration row with no URL, or a missing credential.
 */
export const resolveMcpTarget = async (
  connection: McpConnectionTarget,
): Promise<McpTarget> => {
  const authKind = connection.mcpAuthKind;
  if (authKind === null) {
    throw new Error(
      `Connection "${connection.displayName}" is not an MCP connection.`,
    );
  }
  if (connection.mcpServerUrl === null) {
    throw new Error(
      `Connection "${connection.displayName}" predates the direct MCP transport — remove it and reconnect.`,
    );
  }
  await assertPublicHttpsUrl(connection.mcpServerUrl);
  const credential = await resolveCredential(connection, authKind);
  const transportType = connection.mcpTransport === "sse" ? "sse" : "http";
  return buildMcpTarget(connection.mcpServerUrl, credential, transportType);
};
