import { BUILTIN_TOOL_POLICY_CATALOG } from "@fretik/shared/schemas/tool-policies";

/**
 * Which tools a sub-agent (`dispatchAgent`) gets: everything that READS or
 * COMPUTES, nothing that changes the team's data, nothing that talks to the
 * user.
 *
 * The line is the one the policy catalog already draws. Every policy-managed
 * tool declares `kind: "read" | "write"` there, so a sub-agent takes the reads
 * and never the writes — a write tool added to the product is excluded from
 * sub-agents on the day it is added, without anyone remembering to. Why no
 * writes at all: a sub-agent's calls never reach the conversation's stream, so
 * a write it made is one the user never saw, and an approval it opened has no
 * card to answer it (and would block every later approval in the
 * conversation). The parent writes, where the user watches.
 *
 * `buildSubAgentTools` lists the tools BY NAME — a concrete registry keeps its
 * static type — and a unit test holds that list to this rule in both
 * directions, so the two cannot drift.
 */

/**
 * Tools outside the policy catalog a sub-agent may call. The catalog covers
 * only what a team can switch off; these are the always-on workhorses. A tool
 * that is in neither list is refused — a new infrastructure tool reaches
 * sub-agents by being added here, deliberately.
 *
 * `python`/`bash` write only to the sandbox, where a sub-agent's cells run in
 * a kernel of their own and every call they make to the team's data or apps
 * is read-only (`@fretik/shared/services/sandbox/exec-scope`).
 */
const SUB_AGENT_INFRA_TOOLS: ReadonlySet<string> = new Set([
  "searchKnowledge",
  "querySql",
  "read",
  "extract",
  "vision",
  "transform",
  "python",
  "bash",
]);

/**
 * Catalog READS a sub-agent still does not get: each one's result is
 * something only the parent can use. A skill draft renders as a card in the
 * parent's stream, and icons exist to decorate a page, which only the page
 * builder writes.
 */
const PARENT_ONLY_READS: ReadonlySet<string> = new Set([
  "createSkill",
  "updateSkill",
  "searchIcons",
]);

/** Whether a sub-agent may carry the tool registered under `name`. */
export const isSubAgentTool = (name: string): boolean => {
  const descriptor = BUILTIN_TOOL_POLICY_CATALOG[name];
  if (descriptor !== undefined) {
    return descriptor.kind === "read" && !PARENT_ONLY_READS.has(name);
  }
  return SUB_AGENT_INFRA_TOOLS.has(name);
};
