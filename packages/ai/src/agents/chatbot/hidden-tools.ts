import { CHECK_AGENTS_TOOL } from "../../tools/check-agents";
import { policyHiddenToolNames } from "../shared/policy-tool-gate";
import type { AgentRuntimeContext } from "../shared/runtime-context";

/**
 * The team's blocked tools, plus `checkAgents` while there is nothing for it
 * to report on: shown when the turn started with background sub-agents open
 * (`backgroundAgents`) or once this turn launched one (it activates the tool).
 */
export const chatbotHiddenToolNames = (
  ctx: AgentRuntimeContext,
): ReadonlySet<string> => {
  const hidden = policyHiddenToolNames(ctx);
  const open =
    ctx.backgroundAgents === true ||
    ctx.dynamicToolManager.isActivated(CHECK_AGENTS_TOOL);
  if (open) return hidden;
  const withGate = new Set(hidden);
  withGate.add(CHECK_AGENTS_TOOL);
  return withGate;
};
