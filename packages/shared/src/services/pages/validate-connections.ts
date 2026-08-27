import db from "../../db";
import { listProviderKeys } from "../../external-apps/registry";
import type { PageDefinition } from "../../schemas/pages";

/**
 * Refuse a page whose datasets or operations name an app that does not exist.
 *
 * This is the one data-half check that REFUSES rather than warns, and it sits
 * beside the compiler for the same reason: the failure is certain, permanent
 * and invisible. A dataset pointing at an unknown provider does not error at
 * view time — `resolvePageConnection` finds no row and answers
 * `needs_connection`, which reads to a viewer as "you are not connected" and to
 * the agent, in `dry_run`, as a fact about the acting user rather than a defect
 * in what it just wrote. A page shipped that way can never show data, and
 * nothing downstream says so.
 *
 * `sanitizePageDefinition` has already folded the spelling (`akanea_wms` →
 * `akanea-wms`), so what reaches here is a key that survived the repair: an app
 * this workspace genuinely does not have.
 *
 * Known keys are the registry UNION the team's own connections. The union is
 * load-bearing: an MCP connection's key is a slug minted at connect time
 * (`mcp/custom-provider-key.ts`) and is never in the registry, so the registry
 * alone would refuse every page over a custom MCP server.
 */
/**
 * Provider keys the team has an ACTIVE connection for, whoever owns it.
 *
 * Distinguishes the two states a `needs_connection` dataset can be in, which a
 * single message used to blur: "nobody here has connected this app, so the page
 * is broken for everyone" versus "the team is connected and only you are not".
 * The first is a defect in the page; the second is a fact about the viewer.
 */
export const teamConnectedProviderKeys = async (
  teamId: string,
): Promise<Set<string>> => {
  const rows = await db.query.externalAppConnections.findMany({
    columns: { providerKey: true },
    where: { teamId, status: "active" },
  });
  return new Set(rows.map((row) => row.providerKey));
};

export const validatePageDefinitionConnections = async (params: {
  definition: PageDefinition;
  teamId: string;
}): Promise<{ errors: string[] }> => {
  const named = new Map<string, string[]>();
  const remember = (providerKey: string | undefined, where: string): void => {
    if (providerKey === undefined) return;
    named.set(providerKey, [...(named.get(providerKey) ?? []), where]);
  };

  for (const dataset of params.definition.datasets) {
    // A pinned connectionId is resolved by id and carries its own provider —
    // the providerKey beside it is decoration (sanitize already says so).
    if (dataset.kind !== "external" || dataset.connectionId !== undefined) {
      continue;
    }
    remember(dataset.providerKey, `dataset "${dataset.id}"`);
  }
  for (const operation of params.definition.operations) {
    if (operation.kind !== "app" || operation.connectionId !== undefined) {
      continue;
    }
    remember(operation.providerKey, `operation "${operation.id}"`);
  }
  if (named.size === 0) return { errors: [] };

  const connected = await db.query.externalAppConnections.findMany({
    columns: { providerKey: true },
    where: { teamId: params.teamId },
  });
  const known = new Set([
    ...listProviderKeys(),
    ...connected.map((row) => row.providerKey),
  ]);
  // Nothing to compare against — a process that registered no providers for a
  // team with no connections cannot tell a typo from an app it has not loaded.
  // Refusing on that would turn an environment gap into a user-facing 400.
  if (known.size === 0) return { errors: [] };

  const catalogue = [...known].sort().join(", ");
  const errors: string[] = [];
  for (const [providerKey, wheres] of named) {
    if (known.has(providerKey)) continue;
    errors.push(
      `${wheres.join(", ")}: providerKey "${providerKey}" is not an app this workspace has. Available: ${catalogue}. Spell it exactly as the connections list prints it — the Python module name (\`fretik_apps.akanea_wms\`) is NOT the providerKey (\`akanea-wms\`).`,
    );
  }
  return { errors };
};
