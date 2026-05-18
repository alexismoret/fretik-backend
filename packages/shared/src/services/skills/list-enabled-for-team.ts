import { listSkillsForTeam } from "./list-for-team";

/**
 * Subset of a skill exposed in the chatbot system prompt's L1
 * catalogue listing. Intentionally minimal — anything beyond
 * `name + description` would bloat the cache prefix and dilute the
 * model's description-matching for auto-activation. The agent reads
 * the full SKILL.md body on demand via the `read` tool.
 */
export interface PromptSkillEntry {
  name: string;
  description: string;
}

/**
 * Catalogue of skills exposed to the chatbot for a given team.
 *
 * Anthropic's recommended pattern is "filter the catalogue upstream,
 * never instruct the model negatively" — a skill the team has
 * disabled simply never appears in the prompt, so the agent has no
 * way to know it exists and can't accidentally call into it.
 *
 *  - Always-on skills (`isDefault = true`) are always present.
 *  - Configurable skills are present only when no team override
 *    exists OR the override sets `enabled = true`.
 *  - Soft-deleted catalogue rows are excluded by `listSkillsForTeam`.
 *
 * Cache cost: the system prompt's STATIC PREFIX becomes
 * team-variable as a result, which means a cache miss the first time
 * a unique team's overrides change. This is acceptable and matches
 * Anthropic's published guidance (cf. `prompt-caching.md` in
 * `anthropics/skills`): filtering by tenant is preferred over a
 * static "all skills + negative instructions" prefix because the
 * latter pays the negative-instruction tokens on every turn forever.
 */
export const listEnabledSkillsForTeam = async (
  teamId: string,
): Promise<PromptSkillEntry[]> => {
  const all = await listSkillsForTeam(teamId);
  return all
    .filter((skill) => skill.enabled)
    .map((skill) => ({ name: skill.name, description: skill.description }));
};
