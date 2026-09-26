import { MANAGE_AGENTS_TOOL } from "../../tools/manage-agents";
import { policyHiddenToolNames } from "../shared/policy-tool-gate";
import type { AgentRuntimeContext } from "../shared/runtime-context";
import { manageAgentsHidden } from "../shared/sub-agent-tool-gate";

/**
 * The team's blocked tools, plus `manageAgents` while the conversation has no
 * sub-agent for it to manage (`../shared/sub-agent-tool-gate.ts`).
 */
export const chatbotHiddenToolNames = (
  ctx: AgentRuntimeContext,
): ReadonlySet<string> => {
  const hidden = policyHiddenToolNames(ctx);
  if (!manageAgentsHidden(ctx)) return hidden;
  const withGate = new Set(hidden);
  withGate.add(MANAGE_AGENTS_TOOL);
  return withGate;
};
