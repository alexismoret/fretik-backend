import { canonicalProviderKey } from "@fretik/shared/external-apps/canonical-provider-key";
import { teamConnectedProviderKeys } from "@fretik/shared/services/pages/validate-connections";
import { readSkillWorkspaceFile } from "../skills/read-skill-file";

/**
 * What the builder needs to read a connected app, handed over before it starts.
 *
 * The measured failure this exists for (Langfuse `01a03e9b…`, 2026-08-26): a
 * build over an external app declared its datasets with `akanea_wms` — the
 * PYTHON MODULE name — instead of `akanea-wms`, the connection key. Five
 * `needs_connection` answers later it decided the data was unreachable and
 * wrote 78 invented rows. The provider's own skill, which names the key, the
 * actions and their arguments, was never in its context: the builder is a
 * delegate, and nothing carried it across.
 *
 * Three facts per app, in this order because that is the order they change a
 * decision: the key as it must be written, whether the team is connected at
 * all, and then how to read from it.
 */

/** Enough of a provider skill to write a dataset; past this it is a manual. */
const MAX_SKILL_CHARS = 20_000;

export interface ExternalAppsBlock {
  /** The rendered `<external_apps>` block, or null when nothing resolved. */
  block: string | null;
  /** Keys that resolved to no known app — reported, never guessed at. */
  unknown: string[];
}

export const describeExternalApps = async (params: {
  keys: readonly string[];
  conversationId: string | undefined;
  teamId: string;
}): Promise<ExternalAppsBlock> => {
  if (params.keys.length === 0) return { block: null, unknown: [] };

  const connected = await teamConnectedProviderKeys(params.teamId).catch(
    () => new Set<string>(),
  );

  const sections: string[] = [];
  const unknown: string[] = [];

  for (const raw of params.keys) {
    const key = canonicalProviderKey(raw.trim());
    if (key.length === 0) {
      unknown.push(raw);
      continue;
    }
    const guidance =
      params.conversationId === undefined
        ? null
        : await readSkillWorkspaceFile(
            params.conversationId,
            `skills/${key}/SKILL.md`,
          ).catch(() => null);
    if (guidance === null) {
      unknown.push(raw);
      continue;
    }

    const isConnected = connected.has(key);
    sections.push(
      [
        `## ${key}`,
        `providerKey: \`${key}\` — write it exactly like that in a dataset's \`providerKey\`. The module name is not the key.`,
        isConnected
          ? 'The team has an active connection. Read from it with a dataset `{ kind: "external", providerKey, operation, args }`; the viewer\'s own connection is used at view time.'
          : "NO active connection on this team: do not declare a dataset over this app, say so in your summary, and never fill it with rows of your own.",
        "",
        guidance.length > MAX_SKILL_CHARS
          ? `${guidance.slice(0, MAX_SKILL_CHARS)}\n…[skill truncated — read skills/${key}/SKILL.md for the rest]`
          : guidance,
      ].join("\n"),
    );
  }

  return {
    block:
      sections.length > 0
        ? `<external_apps>\n${sections.join("\n\n")}\n</external_apps>`
        : null,
    unknown,
  };
};
