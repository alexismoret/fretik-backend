import type {
  Agent,
  GenerateTextResult,
  ModelMessage,
  ToolExecutionOptions,
  ToolSet,
} from "ai";
import { getRuntimeContext, type AgentRuntimeContext } from "./runtime-context";

/**
 * Scaffolding helpers for the agent-as-tool pattern (Phase 7.5).
 *
 * Wraps a `ToolLoopAgent` (or any AI SDK `Agent<CALL_OPTIONS, TOOLS>`)
 * so the chatbot can dispatch to it as a single tool call. The
 * parent supplies high-level input, the sub-agent builds its own
 * messages and runs its own tool loop in isolation via
 * `.generate()`, and the summarised result is returned as a regular
 * tool output.
 *
 * This file is **scaffolding only** — no concrete sub-agent is
 * registered in `buildDomainTools` as part of Phase 7.5. It exists
 * so the first real post-v1 sub-agent (workflow-agent,
 * extraction-agent, research-agent, …) doesn't need an additional
 * architectural refactor. Consumers keep the tight strong typing on
 * their own side (their own INPUT / OUTPUT Zod schema + their own
 * typed CALL_OPTIONS), and feed this helper's `execute` function
 * into their own `buildChatbotTool({ ..., execute })` call.
 *
 * Mirrors Claude Code's `AgentTool` pattern — the parent agent
 * exposes a single `task({ description, prompt })` tool whose
 * execute spawns a sub-agent, runs it to completion, and returns
 * the summary as the tool result.
 *
 * Example usage (post-v1):
 *
 * ```ts
 * // 1. Build the sub-agent once at module init.
 * const workflowAgentSet = buildAgentSet<WorkflowCallOptions, WorkflowTools>(...);
 *
 * // 2. Build the strongly-typed execute closure.
 * const runWorkflowAgent = createSubAgentExecute({
 *   subAgent: workflowAgentSet.primary,
 *   buildMessages: ({ task }) => [{ role: "user", content: task }],
 *   buildCallOptions: (_args, ctx) => ({
 *     teamId: ctx.teamId,
 *     organizationId: ctx.organizationId,
 *   }),
 *   formatResult: (result) => ({ summary: result.text }),
 * });
 *
 * // 3. Register it as a regular chatbot domain tool.
 * export const workflowSubAgentTool = buildChatbotTool({
 *   category: "domain",
 *   searchHint: "workflow build dispatch sub-agent plan steps",
 *   description: "Delegate a workflow-building task to the workflow sub-agent.",
 *   inputSchema: z.object({ task: z.string() }),
 *   execute: runWorkflowAgent,
 * });
 * ```
 *
 * Anti-pattern reminder: the sub-agent instance is a singleton. Its
 * tools — like every other chatbot tool — MUST read per-request
 * state from `experimental_context` via `getRuntimeContext`. This
 * helper injects the parent's runtime context into the sub-agent's
 * own `prepareCall` via the typed `CALL_OPTIONS` so both the parent
 * and the sub-agent end up with the same scoped ctx on every turn.
 */

/**
 * Configuration for the sub-agent-as-tool execute closure.
 *
 * @template CALL_OPTIONS  Typed call options of the sub-agent.
 * @template TOOLS         Tool set of the sub-agent.
 * @template INPUT         Input the parent chatbot sends to the tool.
 * @template OUTPUT        JSON-serializable return shape.
 */
export interface CreateSubAgentExecuteConfig<
  CALL_OPTIONS,
  TOOLS extends ToolSet,
  INPUT,
  OUTPUT,
> {
  /** The wrapped sub-agent instance (primary or dispatcher). */
  subAgent: Agent<CALL_OPTIONS, TOOLS>;
  /**
   * Build the message list the sub-agent consumes from the parent's
   * input and the live runtime context (useful for stitching in
   * team/user identity or a tight scoping preamble).
   */
  buildMessages: (input: INPUT, ctx: AgentRuntimeContext) => ModelMessage[];
  /**
   * Build the sub-agent's typed `CALL_OPTIONS` from the parent's
   * runtime context. Runs on every invocation so team/user scoping
   * is always fresh.
   */
  buildCallOptions: (input: INPUT, ctx: AgentRuntimeContext) => CALL_OPTIONS;
  /**
   * Map the sub-agent's `GenerateTextResult` to the serializable
   * payload returned to the parent. Keep it tight — the parent will
   * see this verbatim in its own context window.
   */
  formatResult: (
    result: GenerateTextResult<TOOLS, Record<string, unknown>, never>,
  ) => OUTPUT;
}

/**
 * Build a strongly-typed `execute` closure that dispatches the
 * parent's tool call to the wrapped sub-agent. Consumers plug the
 * returned function into `buildChatbotTool({ execute })` — see the
 * usage example at the top of this file.
 */
export const createSubAgentExecute = <
  CALL_OPTIONS,
  TOOLS extends ToolSet,
  INPUT,
  OUTPUT,
>(
  config: CreateSubAgentExecuteConfig<CALL_OPTIONS, TOOLS, INPUT, OUTPUT>,
) => {
  return async (
    input: INPUT,
    options: ToolExecutionOptions<unknown>,
  ): Promise<OUTPUT> => {
    const ctx = getRuntimeContext(options);
    const messages = config.buildMessages(input, ctx);
    const callOptions = config.buildCallOptions(input, ctx);
    const result = await config.subAgent.generate({
      messages,
      options: callOptions,
      abortSignal: options.abortSignal,
    });
    return config.formatResult(result);
  };
};
