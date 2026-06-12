import type { Agent, GenerateTextResult, ToolSet } from "ai";
import { z } from "zod";
import type { ChatbotCallOptions } from "../agents/chatbot";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import { createSubAgentExecute } from "../agents/shared/sub-agent";

/**
 * `dispatchAgent` tool — delegate an encapsulated sub-task to a fresh
 * sub-agent that runs in isolation and returns a tight summary as the
 * tool result. Pattern aligned with Claude Code's `Agent` (formerly
 * `Task`) tool and OpenClaw's `sessions_spawn`.
 *
 * Two model paths are exposed via the `model` parameter:
 *   - `"primary"` (default) — same model as the main agent, for
 *     sub-tasks that need real reasoning.
 *   - `"cheap"`              — `dispatchAgentCheapModel`
 *     (`deepseek/deepseek-v4-flash` by default), for well-scoped
 *     mechanical sub-tasks.
 *
 * The model is selected at call time by routing through the matching
 * pre-built `AgentSet`. Both sets share:
 *   - The same sub-agent system prompt (~500-700 tokens, much
 *     shorter than the main agent prompt).
 *   - The same tool registry (chatbot core + domain tools, MINUS
 *     `dispatchAgent` to prevent recursion and `searchTools` because
 *     all domain tools are pre-loaded for the sub-agent — no
 *     Progressive Disclosure needed inside a sub-agent run).
 *   - The same `ChatbotCallOptions` shape so the parent's runtime
 *     context (teamId / userId / conversationId / …) is forwarded
 *     verbatim — the sub-agent operates on the same workspace and
 *     the same data scope as the parent.
 *
 * Anti-recursion: the sub-agent tool registry intentionally OMITS
 * `dispatchAgent`, so a sub-agent cannot spawn a sub-sub-agent.
 *
 * Failure semantics: errors bubble up via the `createSubAgentExecute`
 * helper (no special swallowing). The parent agent sees the error
 * payload and decides whether to retry / give up — same contract as
 * any other tool failure.
 */

/**
 * Input schema of the `dispatchAgent` tool. Hoisted to module scope —
 * it closes over nothing in the factory — so the eval harness's
 * `evals/tool-schemas.ts` can validate recorded tool calls without
 * constructing the sub-agent sets the factory requires.
 */
export const dispatchAgentInputSchema = z.object({
  task: z
    .string()
    .min(10)
    .describe(
      "Self-contained instruction for the sub-agent: goal + context + expected output format. The sub-agent reads no other context, so include every relevant file path, ID, and acceptance criterion verbatim.",
    ),
  description: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "Short (3-5 word) label shown in traces and the UI. Example: 'Compare 5 invoices'.",
    ),
  model: z
    .enum(["primary", "cheap"])
    .optional()
    .describe(
      "'primary' (default): same model as the main agent — use when the sub-task needs reasoning, judgment, or complex multi-step planning. 'cheap': runs on a smaller but tool-strong model (DeepSeek V4 Flash by default) — use for well-scoped mechanical sub-tasks (summarise one document, extract a known schema, classify items).",
    ),
});

/**
 * Factory: build the `dispatchAgent` tool against a pair of pre-built
 * sub-agent sets. Called once from `agents/chatbot/index.ts` after
 * the sub-agent sets are constructed; the main agent's tool registry
 * then plugs the resulting tool in alongside the other core tools.
 *
 * Generic over `TTools` so the type of `subAgentPrimarySet` /
 * `subAgentCheapSet` flows through to the AI SDK without an explicit
 * cast.
 */
export const createDispatchAgentTool = <TTools extends ToolSet>(deps: {
  primary: Agent<ChatbotCallOptions, TTools>;
  cheap: Agent<ChatbotCallOptions, TTools>;
}) => {
  const inputSchema = dispatchAgentInputSchema;

  /**
   * Format the sub-agent's `GenerateTextResult` into the
   * `{ summary, ... }` payload returned to the parent. Adds an
   * `incomplete` flag and a marker prefix when the run stopped
   * because the step budget was exhausted (rather than because the
   * sub-agent emitted a clean final text). The parent can read the
   * flag and decide whether to retry with a tighter scope.
   *
   * AI SDK v6 finish reasons we care about:
   *   - "stop"        → sub-agent produced a final text on its own. Healthy.
   *   - "tool-calls"  → stopped mid-loop, typically because `stepCountIs(N)`
   *                     fired between a tool-call step and the next text step.
   *   - "length"      → output token budget hit (rare for short summaries).
   *   - other         → provider error / content filter / etc.
   */
  const formatSubAgentResult = (
    result: GenerateTextResult<TTools, never>,
  ): { summary: string; incomplete?: boolean; finishReason?: string } => {
    const text = result.text.trim();
    const finishReason = result.finishReason;
    if (finishReason === "stop") {
      return { summary: text };
    }
    const marker = `[incomplete: sub-agent stopped with finishReason="${finishReason}" before producing a clean summary — likely max-steps reached]`;
    return {
      summary: text.length > 0 ? `${marker}\n\n${text}` : marker,
      incomplete: true,
      finishReason,
    };
  };

  const executePrimary = createSubAgentExecute<
    ChatbotCallOptions,
    TTools,
    z.infer<typeof inputSchema>,
    ReturnType<typeof formatSubAgentResult>
  >({
    subAgent: deps.primary,
    buildMessages: ({ task }) => [{ role: "user", content: task }],
    buildCallOptions: (_input, ctx) => ({
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      conversationId: ctx.conversationId,
      timeZone: ctx.timeZone,
      traceId: ctx.traceId ? `${ctx.traceId}.sub` : undefined,
    }),
    formatResult: formatSubAgentResult,
  });

  const executeCheap = createSubAgentExecute<
    ChatbotCallOptions,
    TTools,
    z.infer<typeof inputSchema>,
    ReturnType<typeof formatSubAgentResult>
  >({
    subAgent: deps.cheap,
    buildMessages: ({ task }) => [{ role: "user", content: task }],
    buildCallOptions: (_input, ctx) => ({
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      conversationId: ctx.conversationId,
      timeZone: ctx.timeZone,
      traceId: ctx.traceId ? `${ctx.traceId}.sub-cheap` : undefined,
    }),
    formatResult: formatSubAgentResult,
  });

  return buildChatbotTool({
    category: "core",
    searchHint:
      "delegate sub-agent task encapsulated parallel synthesis isolated context analyse compare multi-source",
    // Sub-agent returns a short summary string only — the per-call
    // payload is always tight. 16K is comfortable headroom without
    // tripping the persisted-output layer for normal turns.
    maxResultSizeChars: 16_000,
    // Spawning a sub-agent has external side effects (LLM calls, tool
    // executions in the shared sandbox). Not read-only.
    isReadOnly: false,
    description: [
      "Delegate an encapsulated sub-task to a fresh sub-agent that runs in isolation and returns a tight summary as the tool result. The sub-agent has its own short context, its own tool loop (read, searchKnowledge, querySql, python, bash, …), and does not see the main conversation.",
      "",
      "Usage:",
      '- Use when a sub-task would otherwise pollute the main context with thousands of tokens of intermediate tool results — e.g. "analyse these 5 documents in parallel and compare them", "find the best matching shipment across 200 rows", "explore three angles of this question and bring back a synthesis".',
      "- Use when the sub-task is well-scoped and can be expressed as a single self-contained instruction.",
      "- For parallelism, launch multiple `dispatchAgent` calls in the same step for independent sub-tasks.",
      "- Don't use for a single tool call — call the tool directly.",
      "- Don't use for N similar files with the same processing — inline parallel tool calls + one `python` is faster. Sub-agents share your `/workspace/` sandbox and their `python` / `bash` calls serialize on a mutex, so N sub-agents all hitting python just queue up.",
      "- Cap parallel dispatch at 3. Beyond 3 truly different angles, batch sequentially — extra sub-agents add ~one model call of setup + summary overhead with diminishing parallelism return.",
      "- Don't use when you need to maintain conversation state mid-task — the sub-agent forgets after returning.",
      "- Don't use when the user expects a live streaming answer — sub-agent results arrive as a single block.",
      "- Don't use when the task requires asking the user for clarification — use `askUserQuestion` in the main loop instead.",
      "- `model: 'primary'` (default): same model as the main agent — use when the sub-task needs reasoning, judgment, or complex multi-step planning.",
      "- `model: 'cheap'`: runs on a smaller but tool-strong model — use for well-scoped mechanical sub-tasks (summarise one document, extract a known schema, classify items).",
      "- Always make the `task` instruction self-contained: include all relevant context, file paths, IDs, and the expected output format. The sub-agent reads no other context.",
    ].join("\n"),
    inputSchema,
    execute: async (input, options) => {
      const route = input.model ?? "primary";
      if (route === "cheap") return executeCheap(input, options);
      return executePrimary(input, options);
    },
  });
};
