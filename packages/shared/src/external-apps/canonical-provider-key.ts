/**
 * Fold a written-down provider key onto the spelling the registry and the
 * `external_app_connections` rows actually carry.
 *
 * A page definition is the one place a provider key is TYPED rather than looked
 * up: the agent writes `providerKey` into a dataset from what it read about the
 * app. What it read is the Python module (`fretik_apps.akanea_wms`), so it
 * writes `akanea_wms` — and `akanea-wms` is what the connection row says. The
 * mismatch never fails loudly: the resolver simply finds no connection and the
 * page shows "connect your account" forever, whatever the team connects.
 *
 * Safe by construction, and this is the whole reason it can be applied blind: a
 * manifest key matches `^[a-z][a-z0-9-]*$` (`manifest-schema.ts`) and an MCP
 * connection's key comes out of `slugify` (`mcp/custom-provider-key.ts`), so
 * neither `_` nor an upper-case letter can appear in a legitimate key. The fold
 * can therefore never turn one valid key into a DIFFERENT valid key — it only
 * ever repairs a spelling that matched nothing.
 *
 * This is a repair, not a licence: `validatePageDefinitionConnections` still
 * refuses a key that is unknown after folding, and `sanitizePageDefinition`
 * rewrites the stored value so the definition stops disagreeing with runtime.
 */
export const canonicalProviderKey = (raw: string): string =>
  raw
    // akaneaWms → akanea-Wms, before the lower-casing erases the boundary.
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
