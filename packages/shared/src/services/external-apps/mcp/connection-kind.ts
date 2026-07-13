import type { ExternalAppConnection } from "../../../db/schema";

/**
 * The single discriminator for "is this connection an MCP connection?" — a
 * derived predicate on the `mcpAuthKind` column (non-NULL ⇔ MCP), replacing the
 * old `isMcpProviderKey(nangoProviderConfigKey)` string-matching scattered
 * across the codebase. One source of truth, no redundant boolean to keep in
 * sync with the auth kind it would shadow.
 *
 * Since the curated catalog was removed, every MCP connection is a custom
 * server: its `providerKey` is a unique minted slug and its tool snapshot is
 * always connection-scoped. There is no longer a "curated vs custom" split.
 */

/** The set of MCP auth kinds — the non-NULL values of `mcpAuthKind`. */
export type McpAuthKind = NonNullable<ExternalAppConnection["mcpAuthKind"]>;

/** True for any MCP connection. */
export const isMcpConnection = <
  T extends Pick<ExternalAppConnection, "mcpAuthKind">,
>(
  row: T,
): row is T & { mcpAuthKind: McpAuthKind } => row.mcpAuthKind !== null;
