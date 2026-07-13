import type { ExternalAppConnection } from "../../../db/schema";

/**
 * The Nango identifiers of a connection, guaranteed non-null.
 *
 * `nangoConnectionId` / `nangoProviderConfigKey` became nullable when the
 * `none`-auth MCP kind (a public server with no Nango row) was added. Manifest
 * providers and every Nango-backed kind always populate both, but TypeScript
 * now sees `string | null`. The manifest exec/reconnect paths are only ever
 * reached for a real Nango-backed connection, so this narrows once, at the
 * boundary, and throws loudly if the invariant is ever violated.
 */

export interface NangoRef {
  nangoConnectionId: string;
  nangoProviderConfigKey: string;
}

export const requireNangoRef = (
  row: Pick<
    ExternalAppConnection,
    "id" | "providerKey" | "nangoConnectionId" | "nangoProviderConfigKey"
  >,
): NangoRef => {
  if (row.nangoConnectionId === null || row.nangoProviderConfigKey === null) {
    throw new Error(
      `Connection ${row.id} (${row.providerKey}) has no Nango binding — expected a Nango-backed connection here.`,
    );
  }
  return {
    nangoConnectionId: row.nangoConnectionId,
    nangoProviderConfigKey: row.nangoProviderConfigKey,
  };
};
