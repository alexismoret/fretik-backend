/**
 * MCP connect-flow routing keys.
 *
 * The curated vendor catalog was removed: discovery is now registry-driven
 * (`@fretik/shared/lib/mcp-registry`), and every MCP app's metadata — logo,
 * description, and the `verified` trust signal — is persisted per-connection at
 * confirm (`external_app_connections.{iconUrl,description,catalogMeta}`) rather
 * than read from a const here. What remains is the wire-key routing for the
 * connect flow plus a small reserved-slug guard.
 */

/**
 * Nango integration keys the connect flow accepts for a custom MCP server. The
 * auth kind is derived from WHICH key the frontend posts (see
 * `connections/confirm-mcp`) — the client never asserts an auth kind directly.
 *
 *  - `mcp-generic`     : custom server over OAuth (Nango DCR/CIMD).
 *  - `mcp-custom-key`  : custom server with an API key (Nango vault,
 *                        `private-api-bearer`).
 *  - `mcp-custom-basic`: custom server with HTTP Basic (Nango vault,
 *                        `private-api-basic`).
 *  - `mcp-custom-none` : public custom server, no auth (no Nango row).
 */
export const MCP_GENERIC_PROVIDER_KEY = "mcp-generic";
export const MCP_CUSTOM_API_KEY_PROVIDER_KEY = "mcp-custom-key";
export const MCP_CUSTOM_BASIC_PROVIDER_KEY = "mcp-custom-basic";
export const MCP_CUSTOM_NO_AUTH_PROVIDER_KEY = "mcp-custom-none";

const CUSTOM_MCP_CONNECT_KEYS = new Set([
  MCP_GENERIC_PROVIDER_KEY,
  MCP_CUSTOM_API_KEY_PROVIDER_KEY,
  MCP_CUSTOM_BASIC_PROVIDER_KEY,
  MCP_CUSTOM_NO_AUTH_PROVIDER_KEY,
]);

/**
 * True for a wire providerKey the connect flow routes as MCP. With the curated
 * catalog gone, that's exactly the four custom pseudo-keys. Wire-level routing
 * ONLY (confirm / connect-session, where we hold a key string, not a row); a
 * stored row's MCP-ness is decided by `mcp/connection-kind.isMcpConnection`.
 */
export const isMcpConnectKey = (providerKey: string): boolean =>
  CUSTOM_MCP_CONNECT_KEYS.has(providerKey);

/**
 * Slugs a custom server must never mint as its provider key: the connect-flow
 * pseudo-keys (so a custom server can't collide with routing) plus a few
 * well-known brand slugs. The real anti-masquerade guard is that an app's
 * logo/name/trust come from its ACTUAL endpoint (registry metadata, or the
 * URL's favicon), never from the slug — so a fake `notion` server shows no
 * Notion identity regardless. This set is belt-and-braces for the module name.
 */
export const RESERVED_MCP_SLUGS: ReadonlySet<string> = new Set([
  ...CUSTOM_MCP_CONNECT_KEYS,
  "notion",
  "slack",
  "linear",
  "hubspot",
  "asana",
  "attio",
  "canva",
  "github",
  "gmail",
  "outlook",
]);
