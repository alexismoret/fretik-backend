import db from "../../../db";
import {
  externalAppConnections,
  type ExternalAppConnection,
  type McpCatalogMeta,
} from "../../../db/schema";
import { asString, isRecord } from "../../../external-apps/json-access";
import { throwHttpError } from "../../../lib/errors";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { assertPublicHttpsUrl } from "../../../lib/net/assert-public-https-url";
import { ERROR_CODES } from "../../../schemas/errors";
import type { ConfirmMcpParams } from "../../../schemas/external-apps";
import { emitDomainEvent } from "../../domain-events/emit";
import {
  MCP_CUSTOM_API_KEY_PROVIDER_KEY,
  MCP_CUSTOM_BASIC_PROVIDER_KEY,
  MCP_CUSTOM_NO_AUTH_PROVIDER_KEY,
  MCP_GENERIC_PROVIDER_KEY,
} from "../mcp/catalog";
import type { McpAuthKind } from "../mcp/connection-kind";
import { generateCustomMcpProviderKey } from "../mcp/custom-provider-key";
import { faviconUrlForServer } from "../mcp/favicon";

/**
 * Confirm an MCP connection — the branch `confirmConnection` delegates to when
 * `getProvider` is undefined and the wire providerKey routes as MCP.
 *
 * The auth kind is derived SERVER-SIDE from which wire providerKey the frontend
 * posts (never asserted by the client), and the server URL comes from a trusted
 * source per kind:
 *
 *  | wire providerKey   | Nango     | serverUrl source                          | authKind    |
 *  |--------------------|-----------|-------------------------------------------|-------------|
 *  | `mcp-generic`      | required  | connection_config.mcp_server_url ∥ params | nango-oauth |
 *  | `mcp-custom-key`   | required  | params.mcp.serverUrl                      | api-key     |
 *  | `mcp-custom-basic` | required  | params.mcp.serverUrl                      | basic       |
 *  | `mcp-custom-none`  | forbidden | params.mcp.serverUrl                      | none        |
 *
 * The URL is SSRF-checked before it's persisted. Discovery-catalog metadata
 * (logo, description, `verified` → auto-run trust) is persisted from the confirm
 * params; a raw-URL server gets a Google favicon and never auto-runs reads.
 * Introspection (the API handler, best-effort) doubles as connectivity validation.
 */

export interface ConfirmMcpConnectionParams {
  organizationId: string;
  teamId: string;
  userId: string;
  scope: "team" | "user";
  providerKey: string;
  displayName: string;
  nangoConnectionId?: string;
  mcp?: ConfirmMcpParams;
}

interface ResolvedMcpConfirm {
  authKind: McpAuthKind;
  /** Fretik provider key (== descriptor / Python module / snapshot key). */
  providerKey: string;
  /** Nango integration key, or null for a no-auth server. */
  nangoProviderConfigKey: string | null;
  serverUrl: string;
  apiKeyHeader: string | null;
}

const badRequest = (message: string): never =>
  throwHttpError(400, {
    code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
    message,
  });

const requiredServerUrl = (params: ConfirmMcpConnectionParams): string => {
  const url = params.mcp?.serverUrl;
  if (url === undefined || url === "") {
    return badRequest("A custom MCP server requires its URL.");
  }
  return url;
};

const mintSlug = (params: ConfirmMcpConnectionParams): Promise<string> =>
  generateCustomMcpProviderKey({
    displayName: params.displayName,
    teamId: params.teamId,
  });

/**
 * Verify the Nango connection exists (defense against a spoofed id) and return
 * its `connection_config` (needed to recover the mcp-generic server URL).
 */
const verifyNango = async (
  params: ConfirmMcpConnectionParams,
  nangoProviderConfigKey: string,
): Promise<unknown> => {
  if (params.nangoConnectionId === undefined) {
    return badRequest("This MCP connection requires a Nango connection id.");
  }
  try {
    const conn = await getNangoClient().getConnection(
      nangoProviderConfigKey,
      params.nangoConnectionId,
    );
    return conn.connection_config;
  } catch (error) {
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: "Failed to verify the Nango connection",
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * The `mcp-generic` server URL: prefer what Nango captured in Connect UI
 * (`connection_config.mcp_server_url`), fall back to the URL the hub already
 * resolved from the discovery catalog (`params.mcp.serverUrl`). One of the two
 * must be present.
 */
const recoverGenericServerUrl = (
  connectionConfig: unknown,
  fallback: string | undefined,
): string => {
  const url = asString(
    isRecord(connectionConfig) ? connectionConfig.mcp_server_url : undefined,
  );
  if (url !== undefined && url !== "") return url;
  if (fallback !== undefined && fallback !== "") return fallback;
  return badRequest(
    "The custom MCP server did not report its URL — reconnect it.",
  );
};

const resolveMcpConfirm = async (
  params: ConfirmMcpConnectionParams,
): Promise<ResolvedMcpConfirm> => {
  switch (params.providerKey) {
    case MCP_GENERIC_PROVIDER_KEY: {
      const connectionConfig = await verifyNango(
        params,
        MCP_GENERIC_PROVIDER_KEY,
      );
      return {
        authKind: "nango-oauth",
        providerKey: await mintSlug(params),
        nangoProviderConfigKey: MCP_GENERIC_PROVIDER_KEY,
        serverUrl: recoverGenericServerUrl(
          connectionConfig,
          params.mcp?.serverUrl,
        ),
        apiKeyHeader: null,
      };
    }
    case MCP_CUSTOM_API_KEY_PROVIDER_KEY: {
      await verifyNango(params, MCP_CUSTOM_API_KEY_PROVIDER_KEY);
      return {
        authKind: "api-key",
        providerKey: await mintSlug(params),
        nangoProviderConfigKey: MCP_CUSTOM_API_KEY_PROVIDER_KEY,
        serverUrl: requiredServerUrl(params),
        apiKeyHeader: params.mcp?.apiKeyHeader ?? null,
      };
    }
    case MCP_CUSTOM_BASIC_PROVIDER_KEY: {
      await verifyNango(params, MCP_CUSTOM_BASIC_PROVIDER_KEY);
      return {
        authKind: "basic",
        providerKey: await mintSlug(params),
        nangoProviderConfigKey: MCP_CUSTOM_BASIC_PROVIDER_KEY,
        serverUrl: requiredServerUrl(params),
        apiKeyHeader: null,
      };
    }
    case MCP_CUSTOM_NO_AUTH_PROVIDER_KEY: {
      if (params.nangoConnectionId !== undefined) {
        badRequest("A no-auth MCP server must not carry a Nango connection.");
      }
      return {
        authKind: "none",
        providerKey: await mintSlug(params),
        nangoProviderConfigKey: null,
        serverUrl: requiredServerUrl(params),
        apiKeyHeader: null,
      };
    }
    default:
      return throwHttpError(404, {
        code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
        message: `Unknown provider: ${params.providerKey}`,
      });
  }
};

/**
 * Persisted discovery metadata for the connection: the logo (catalog `iconUrl`
 * or a favicon fallback), description, and `catalogMeta`. `verified` is clamped
 * so ONLY a catalog app (carrying a `qualifiedName`) can hold auto-run trust —
 * a raw-URL server never does.
 */
const buildCatalogFields = (
  params: ConfirmMcpConnectionParams,
  serverUrl: string,
): {
  iconUrl: string | null;
  description: string | null;
  catalogMeta: McpCatalogMeta | null;
} => {
  const mcp = params.mcp;
  const rawMeta = mcp?.catalogMeta;
  const catalogMeta: McpCatalogMeta | null =
    rawMeta === undefined
      ? null
      : {
          qualifiedName: rawMeta.qualifiedName,
          homepage: rawMeta.homepage,
          categories: rawMeta.categories,
          verified:
            rawMeta.qualifiedName !== undefined && rawMeta.verified === true,
        };
  return {
    iconUrl: mcp?.iconUrl ?? faviconUrlForServer(serverUrl),
    description: mcp?.description ?? null,
    catalogMeta,
  };
};

export const confirmMcpConnection = async (
  params: ConfirmMcpConnectionParams,
): Promise<ExternalAppConnection> => {
  const resolved = await resolveMcpConfirm(params);
  await assertPublicHttpsUrl(resolved.serverUrl);
  const catalog = buildCatalogFields(params, resolved.serverUrl);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(externalAppConnections)
      .values({
        organizationId: params.organizationId,
        teamId: params.teamId,
        userId: params.scope === "user" ? params.userId : null,
        providerKey: resolved.providerKey,
        displayName: params.displayName,
        nangoConnectionId: params.nangoConnectionId ?? null,
        nangoProviderConfigKey: resolved.nangoProviderConfigKey,
        mcpAuthKind: resolved.authKind,
        mcpServerUrl: resolved.serverUrl,
        mcpApiKeyHeader: resolved.apiKeyHeader,
        mcpTransport: params.mcp?.transport ?? null,
        iconUrl: catalog.iconUrl,
        description: catalog.description,
        catalogMeta: catalog.catalogMeta,
        createdByUserId: params.userId,
        status: "active",
        options: null,
      })
      .returning();
    if (row === undefined) {
      return throwHttpError(500, {
        code: ERROR_CODES.DATABASE_ERROR,
        message: "Failed to insert connection row",
      });
    }
    await emitDomainEvent({
      tx,
      organizationId: params.organizationId,
      teamId: params.teamId,
      type: "connector.connected",
      actor: { actorType: "user", actorUserId: params.userId },
      subjectType: "connector",
      payload: { providerKey: row.providerKey, connectionId: row.id },
      dedupKey: `connector.connected:${row.id}`,
    });
    return row;
  });
};
