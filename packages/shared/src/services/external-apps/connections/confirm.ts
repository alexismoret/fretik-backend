import { z } from "zod";
import db from "../../../db";
import {
  externalAppConnections,
  type ExternalAppConnection,
} from "../../../db/schema";
import { buildConnectionOptionsZod } from "../../../external-apps/connection-options-validator";
import { isRecord } from "../../../external-apps/json-access";
import { normalizeNangoCredentials } from "../../../external-apps/normalize-nango-credentials";
import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { ERROR_CODES } from "../../../schemas/errors";
import type { ConfirmMcpParams } from "../../../schemas/external-apps";
import { emitDomainEvent } from "../../domain-events/emit";
import { isMcpConnectKey } from "../mcp/catalog";
import { confirmMcpConnection } from "./confirm-mcp";
import { invalidateConnectionCaches } from "./epoch";

/**
 * Confirm a connection created via Connect UI (for `nango-proxy` OAuth
 * providers) or via headless `nango.auth(...)` (for `custom-handler`
 * providers using their own descriptor-driven credentials form).
 *
 * In both cases the frontend has already created the connection in Nango
 * and now POSTs the resulting `nangoConnectionId` so we can:
 *
 *  1. Verify the connection exists in Nango (sanity + defense against a
 *     hostile client posting fake IDs).
 *  2. For `custom-handler` providers that advertise `testConnection.supported`,
 *     run `provider.testCredentials(...)` against the stored credentials —
 *     this is the only place we can catch a misconfigured IMAP/SMTP host
 *     or a typo'd password BEFORE the user discovers it through a failing
 *     chatbot action. If KO, the row is still created (so the user can
 *     find and fix it) but with `status: 'error'` + `lastErrorMessage`.
 *  3. Upsert the Fretik-side row (scope, displayName, audit).
 *
 * Nango remains the source of truth for credential storage; this row is
 * the Fretik-side metadata.
 */
export const confirmConnection = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  scope: "team" | "user";
  providerKey: string;
  displayName: string;
  /** Absent only for a no-auth custom MCP server (`mcp-custom-none`). */
  nangoConnectionId?: string;
  options?: Record<string, unknown>;
  mcp?: ConfirmMcpParams;
}): Promise<ExternalAppConnection> => {
  const provider = getProvider(params.providerKey);

  // MCP connections have no hand-written manifest — `getProvider` is undefined.
  // Their whole confirm flow (auth-kind derivation, server-URL sourcing, SSRF
  // check, insert) lives in `confirm-mcp` — the api handler then introspects.
  if (provider === undefined && isMcpConnectKey(params.providerKey)) {
    const mcpRow = await confirmMcpConnection({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.userId,
      scope: params.scope,
      providerKey: params.providerKey,
      displayName: params.displayName,
      nangoConnectionId: params.nangoConnectionId,
      mcp: params.mcp,
    });
    await invalidateConnectionCaches({ connection: mcpRow });
    return mcpRow;
  }

  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${params.providerKey}`,
    });
  }

  // Every manifest provider is Nango-backed (only a no-auth MCP server omits
  // the connection id) — narrow it here.
  const nangoConnectionId = params.nangoConnectionId;
  if (nangoConnectionId === undefined) {
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: "Missing Nango connection id",
    });
  }

  // Validate user-supplied options against the provider's descriptor.
  // When the provider declares one, `options` is required on the wire.
  let validatedOptions: Record<string, unknown> | null = null;
  if (provider.manifest.connectionOptions !== undefined) {
    if (params.options === undefined) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
        message: `Provider ${params.providerKey} requires connection options.`,
      });
    }
    const schema = buildConnectionOptionsZod(
      provider.manifest.connectionOptions,
    );
    const parsed = schema.safeParse(params.options);
    if (!parsed.success) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
        message: "Invalid connection options",
        details: z.prettifyError(parsed.error),
      });
    }
    validatedOptions = parsed.data;
  }

  const nango = getNangoClient();
  let nangoConnection;
  try {
    nangoConnection = await nango.getConnection(
      provider.manifest.nangoProviderConfigKey,
      nangoConnectionId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return throwHttpError(400, {
      code: ERROR_CODES.EXTERNAL_APP_NANGO_VERIFY_FAILED,
      message: "Failed to verify the Nango connection",
      details: message,
    });
  }

  // Post-creation credentials check — for descriptor-driven transports
  // (`custom-handler`, `http-direct`) that opted in. For nango-proxy
  // (OAuth) the grant itself is the test, and there's no testCredentials.
  let initialStatus: ExternalAppConnection["status"] = "active";
  let initialError: string | null = null;
  if (
    provider.manifest.transport.kind !== "nango-proxy" &&
    provider.manifest.credentialsForm?.testConnection.supported === true &&
    provider.testCredentials !== undefined
  ) {
    const rawCredentials = isRecord(nangoConnection.credentials)
      ? (nangoConnection.credentials as Record<string, unknown>)
      : {};
    const rawConnectionConfig = isRecord(nangoConnection.connection_config)
      ? (nangoConnection.connection_config as Record<string, unknown>)
      : {};
    // Reverse `nangoKey` rename so the provider's `testCredentials` reads
    // canonical snake_case keys, same shape as the pre-store `/test-credentials`
    // route receives.
    const { credentials, connection_config: connectionConfig } =
      normalizeNangoCredentials(
        provider.manifest,
        rawCredentials,
        rawConnectionConfig,
      );
    try {
      const result = await provider.testCredentials({
        credentials,
        connection_config: connectionConfig,
      });
      if (!result.ok) {
        initialStatus = "error";
        initialError =
          result.scope !== undefined
            ? `${result.scope}: ${result.message}`
            : result.message;
      }
    } catch (error) {
      initialStatus = "error";
      initialError = error instanceof Error ? error.message : String(error);
    }
  }

  // Wrap the insert so the journal entry is co-transactional with it.
  const row = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(externalAppConnections)
      .values({
        organizationId: params.organizationId,
        teamId: params.teamId,
        userId: params.scope === "user" ? params.userId : null,
        providerKey: params.providerKey,
        displayName: params.displayName,
        nangoConnectionId,
        nangoProviderConfigKey: provider.manifest.nangoProviderConfigKey,
        createdByUserId: params.userId,
        status: initialStatus,
        lastErrorMessage: initialError,
        options: validatedOptions,
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
      payload: { providerKey: params.providerKey, connectionId: row.id },
      dedupKey: `connector.connected:${row.id}`,
    });
    return row;
  });

  // Outside the transaction, and after it: a page that was showing "connect
  // your account" must stop the moment this returns, not 20 s later. Cache
  // bookkeeping never belongs INSIDE the write it follows — a Redis failure
  // must not roll back a connection the user successfully made.
  await invalidateConnectionCaches({ connection: row });
  return row;
};
