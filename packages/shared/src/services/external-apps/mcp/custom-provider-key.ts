import db from "../../../db";
import { RESERVED_MCP_SLUGS } from "./catalog";

/**
 * A custom `mcp-generic` server needs its own Fretik provider key — distinct
 * from the shared `mcp-generic` Nango integration key — because the provider
 * key IS the Python module name (`fretik_apps/<key>.py`), the SKILL directory,
 * and the snapshot key. Two custom servers on the same team must never share
 * one, or their sandbox overlays would collide.
 *
 * We slugify the user's chosen display name and dedupe against the team's
 * existing connection keys (append `-2`, `-3`, …). Readable and stable; the
 * snapshot is still connection-scoped so nothing leaks across tenants.
 */

const slugify = (name: string): string => {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "mcp-server";
};

export const generateCustomMcpProviderKey = async (params: {
  displayName: string;
  teamId: string;
}): Promise<string> => {
  const rows = await db.query.externalAppConnections.findMany({
    columns: { providerKey: true },
    where: { teamId: params.teamId },
  });
  // Seed with the team's existing keys PLUS the reserved slugs (connect-flow
  // pseudo-keys + well-known brand names) so a custom server can't collide with
  // routing keys or take an obvious brand's module name.
  const taken = new Set<string>([
    ...rows.map((r) => r.providerKey),
    ...RESERVED_MCP_SLUGS,
  ]);

  const base = slugify(params.displayName);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};
