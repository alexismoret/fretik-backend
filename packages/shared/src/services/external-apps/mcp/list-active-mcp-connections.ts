import db from "../../../db";
import type { McpCatalogMeta } from "../../../db/schema";
import type { McpConnectionTarget } from "./target";

/**
 * The fields the drift refresh + introspection need for one MCP connection —
 * the transport's `McpConnectionTarget` (id + providerKey + displayName + the
 * auth/url columns) plus the current fingerprint and the discovery metadata
 * (`description` + `catalogMeta`, which drive the descriptor + auto-run trust).
 */
export type ActiveMcpConnection = McpConnectionTarget & {
  /** Current snapshot fingerprint (NULL = never introspected). */
  toolFingerprint: string | null;
  description: string | null;
  catalogMeta: McpCatalogMeta | null;
};

/**
 * Every active MCP connection across all teams — the input to the nightly drift
 * refresh. Filtered in SQL on the MCP discriminator (`mcpAuthKind` non-NULL),
 * so a non-MCP manifest connection never enters the sweep.
 */
export const listActiveMcpConnections = async (): Promise<
  ActiveMcpConnection[]
> => {
  const rows = await db.query.externalAppConnections.findMany({
    columns: {
      id: true,
      providerKey: true,
      displayName: true,
      concurrencyMode: true,
      mcpAuthKind: true,
      mcpServerUrl: true,
      mcpApiKeyHeader: true,
      mcpTransport: true,
      nangoProviderConfigKey: true,
      nangoConnectionId: true,
      toolFingerprint: true,
      description: true,
      catalogMeta: true,
    },
    where: { status: "active", mcpAuthKind: { isNotNull: true } },
  });
  return rows;
};
