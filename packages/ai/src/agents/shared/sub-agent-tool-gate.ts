import { MANAGE_AGENTS_TOOL } from "../../tools/manage-agents";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * Whether `manageAgents` is off this step's tool list: until the conversation
 * has a sub-agent, there is nothing for it to report on, and a tool on the
 * list is a tool a model will eventually call for nothing. It joins once the
 * turn started with sub-agents in the conversation (`hasSubAgents`, read by
 * the handler) or once this turn launched one (`dispatchAgent` activates it).
 * Shared by the chat agent and the workflow executor.
 */
export const manageAgentsHidden = (ctx: AgentRuntimeContext): boolean =>
  ctx.hasSubAgents !== true &&
  !ctx.dynamicToolManager.isActivated(MANAGE_AGENTS_TOOL);
