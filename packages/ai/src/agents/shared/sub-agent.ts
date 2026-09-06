import type {
  Agent,
  GenerateTextResult,
  ModelMessage,
  ToolExecutionOptions,
  ToolSet,
} from "ai";
import {
  mergeUsage,
  summarizeRunUsage,
  type StepUsage,
} from "../../lib/turn-usage";
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
  PROGRESS = never,
  SALVAGE = never,
> {
  /**
   * The sub-agent to run, RESOLVED PER CALL from the live runtime context.
   *
   * A function rather than an instance because the model a delegate runs on can
   * be a per-turn decision: `buildPage` reads `pageBuildProfileKey` here so an
   * A/B can repoint the builder without rebuilding the tool. Callers with one
   * fixed agent pass `() => theAgent`, which is the same singleton it always
   * was — the point is that the choice happens at execute time, not at import.
   */
  subAgent: (ctx: AgentRuntimeContext) => Agent<CALL_OPTIONS, TOOLS>;
  /**
   * A second agent to run ONCE when the first came back having produced
   * nothing — the reasoning-only zombie (`agent-builder.ts` logs it): the model
   * spends its output budget on hidden reasoning and finishes `other`/`length`
   * with no text and no tool call.
   *
   * The parent turn has had this chain since C4; a delegate had only the
   * detection, which is how the most expensive call in the product ended up
   * being the one nothing could recover. Measured 2026-08-22 across an eval
   * run: 2 page builds out of 8, both returning no page at all.
   *
   * Retried only when the failed run CHANGED nothing, so a second attempt
   * cannot duplicate a side effect or a half-written page. Optional: without it
   * the behaviour is exactly what it was.
   */
  fallbackSubAgent?: (ctx: AgentRuntimeContext) => Agent<CALL_OPTIONS, TOOLS>;
  /**
   * Which of this sub-agent's tool calls could have changed something.
   * Reads — a guide, a schema lookup, a dry run — return false, and a run that
   * made only those is still safe to retry. Omit it and any tool call at all
   * blocks the retry, which is the conservative default. See `changedNothing`.
   */
  hasSideEffect?: (call: { toolName: string; input: unknown }) => boolean;
  /**
   * Build the message list the sub-agent consumes from the parent's
   * input and the live runtime context (useful for stitching in
   * team/user identity or a tight scoping preamble).
   *
   * May be async: a briefing worth sending is often one the database has to be
   * asked for (`buildPage` reads the row types of the collections it was
   * handed). Doing that read here rather than letting the sub-agent spend tool
   * steps on it is the point.
   */
  buildMessages: (
    input: INPUT,
    ctx: AgentRuntimeContext,
  ) => ModelMessage[] | Promise<ModelMessage[]>;
  /**
   * Build the sub-agent's typed `CALL_OPTIONS` from the parent's
   * runtime context. Runs on every invocation so team/user scoping
   * is always fresh.
   */
  buildCallOptions: (input: INPUT, ctx: AgentRuntimeContext) => CALL_OPTIONS;
  /**
   * Rescue whatever a finished run produced but failed to commit, BEFORE the
   * empty-run retry decides to start over.
   *
   * The ordering is the whole point. A run cut mid-flight can have produced
   * everything but the commit — `buildPage` keeps the files it wrote in a
   * working copy precisely so that it does
   * (`services/page-project/salvage.ts`) — and rebuilding from zero is both
   * the most expensive recovery in the product and a fresh roll of the same
   * dice that just came up short.
   *
   * Returns null when there is nothing to rescue, which is the normal case.
   */
  salvage?: (
    result: GenerateTextResult<TOOLS, Record<string, unknown>, never>,
    ctx: AgentRuntimeContext,
  ) => Promise<SALVAGE | null>;
  /**
   * Map the sub-agent's `GenerateTextResult` to the serializable
   * payload returned to the parent. Keep it tight — the parent will
   * see this verbatim in its own context window.
   */
  formatResult: (
    result: GenerateTextResult<TOOLS, Record<string, unknown>, never>,
    salvaged?: SALVAGE,
    /**
     * What the dispatch spent, summed over EVERY attempt — a fallback retry
     * replaces `result`, and the parent paid for both.
     */
    usage?: StepUsage,
  ) => OUTPUT;
  /**
   * Hard wall-clock cap on one dispatch, REQUIRED. A sub-agent runs an
   * unbounded tool loop inside a single parent tool call: without a
   * deadline, one hung step holds the parent's whole turn open — measured
   * 2026-08-21, a page build whose in-process render stalled kept its turn
   * alive for 45+ minutes, streaming nothing, persisting nothing. The
   * signal is merged with the parent's own abort, so a cancelled turn
   * still cancels the sub-agent immediately.
   */
  deadlineMs: number;
  /**
   * The tool-shaped result returned when the deadline (not the parent's
   * abort) cuts the run. Tool errors are RETURNED, never thrown — a throw
   * surfaces as a 500 and hides the failure from the model.
   */
  onDeadline: (input: INPUT) => OUTPUT;
  /**
   * Turn each of the sub-agent's tool executions into a snapshot the PARENT's
   * tool card can render while the run is still going. Optional: without it
   * the execute stays an ordinary promise, which is what every caller but
   * `buildPage` wants.
   *
   * This is the answer to "the user watches a spinner for five minutes and
   * cannot tell whether anything is happening". A delegate's own tool calls
   * never reach the parent's stream — they run inside one tool execution — so
   * the only way out is for that execution to keep yielding.
   *
   * Return STRUCTURE, not sentences: the shape crosses into the browser and
   * the wording belongs to the locale files, not here.
   */
  progress?: (event: {
    /** 1 for the sub-agent's first tool call, incrementing thereafter. */
    step: number;
    toolName: string;
    input: unknown;
  }) => PROGRESS | undefined;
}

/**
 * A run that finished having CHANGED nothing — the only shape a retry cannot
 * make worse.
 *
 * What makes a retry unsafe is a side effect, not a tool call. "No tool call at
 * all" was standing in for that, and it stands in badly for an agent that reads
 * before it writes: the page builder opens every run with its environment
 * guide, a component lookup and a data probe, so a build that died before
 * saving anything still had three tool calls against it and the net never
 * caught it. Measured 2026-08-23: two of four eval cases lost a whole build
 * that way, and the parent's remedy — call `buildPage` again from zero — is the
 * most expensive recovery in the product (a full rebuild, ~250s).
 *
 * `hasSideEffect` is how a sub-agent names its own writes. Without it the old,
 * stricter test still applies, so a caller that has not thought about it keeps
 * exactly the behaviour it had.
 */
/**
 * The floor under a fallback attempt's wall clock. A retry is only worth
 * launching if it can finish: below this it burns a full prompt to be cut
 * mid-answer, which reads in the trace as a second model failing rather than
 * as a budget that was already gone.
 */
const FALLBACK_MIN_MS = 5 * 60 * 1000;

const changedNothing = (
  result: {
    finishReason: string;
    text: string;
    steps: readonly {
      readonly toolCalls: readonly { toolName: string; input: unknown }[];
    }[];
  },
  hasSideEffect?: (call: { toolName: string; input: unknown }) => boolean,
): boolean =>
  result.finishReason !== "stop" &&
  result.text.trim().length === 0 &&
  result.steps.every((step) =>
    hasSideEffect
      ? step.toolCalls.every((call) => !hasSideEffect(call))
      : step.toolCalls.length === 0,
  );

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
  PROGRESS = never,
  SALVAGE = never,
>(
  config: CreateSubAgentExecuteConfig<
    CALL_OPTIONS,
    TOOLS,
    INPUT,
    OUTPUT,
    PROGRESS,
    SALVAGE
  >,
) => {
  /** One run, shared by both modes. Resolves to the tool-shaped result. */
  const run = async (
    input: INPUT,
    options: ToolExecutionOptions<unknown>,
    onToolStart: ((toolName: string, toolInput: unknown) => void) | undefined,
  ): Promise<OUTPUT> => {
    const ctx = getRuntimeContext(options);
    const messages = await config.buildMessages(input, ctx);
    const callOptions = config.buildCallOptions(input, ctx);
    const startedAt = Date.now();
    const primaryDeadline = AbortSignal.timeout(config.deadlineMs);
    const deadlines: AbortSignal[] = [primaryDeadline];
    const signalFor = (deadline: AbortSignal): AbortSignal =>
      options.abortSignal
        ? AbortSignal.any([options.abortSignal, deadline])
        : deadline;
    try {
      const generate = async (
        agent: Agent<CALL_OPTIONS, TOOLS>,
        deadline: AbortSignal,
      ): Promise<GenerateTextResult<TOOLS, Record<string, unknown>, never>> =>
        agent.generate({
          messages,
          options: callOptions,
          abortSignal: signalFor(deadline),
          // Always passed: a conditional spread here collapses the SDK's
          // `[CALL_OPTIONS] extends [never]` branch and the whole call stops
          // typechecking. A no-op callback costs nothing.
          onToolExecutionStart: (event) => {
            onToolStart?.(event.toolCall.toolName, event.toolCall.input);
          },
        });

      let result = await generate(config.subAgent(ctx), primaryDeadline);
      let usage = summarizeRunUsage(result.steps);
      let salvaged = (await config.salvage?.(result, ctx)) ?? undefined;
      if (
        config.fallbackSubAgent &&
        salvaged === undefined &&
        changedNothing(result, config.hasSideEffect)
      ) {
        console.error(
          `[sub-agent] empty run (finish=${result.finishReason}) — retrying once on the fallback model`,
        );
        /**
         * The fallback gets a floor, not the leftovers. Sharing the primary's
         * signal meant a first attempt that burned the budget handed the
         * second one a signal already aborting — a retry born dead, paid for,
         * and indistinguishable in the trace from a model that failed.
         */
        const fallbackDeadline = AbortSignal.timeout(
          Math.max(
            config.deadlineMs - (Date.now() - startedAt),
            FALLBACK_MIN_MS,
          ),
        );
        deadlines.push(fallbackDeadline);
        result = await generate(config.fallbackSubAgent(ctx), fallbackDeadline);
        usage = mergeUsage(usage, summarizeRunUsage(result.steps));
        salvaged = (await config.salvage?.(result, ctx)) ?? undefined;
      }
      return config.formatResult(result, salvaged, usage);
    } catch (err) {
      // Only a DEADLINE is absorbed into a tool-shaped result. A parent
      // abort must keep propagating (the turn is being torn down), and any
      // other throw is a real bug the caller's error path should see.
      if (
        deadlines.some((deadline) => deadline.aborted) &&
        !options.abortSignal?.aborted
      ) {
        return config.onDeadline(input);
      }
      throw err;
    }
  };

  const report = config.progress;
  if (!report) {
    return (input: INPUT, options: ToolExecutionOptions<unknown>) =>
      run(input, options, undefined);
  }

  /**
   * Progress mode. The run is started ONCE and raced against a signal that the
   * tool-start callback fires; every wake-up yields the latest snapshot, and
   * the finished result is yielded last — the SDK marks every earlier yield
   * `preliminary`, so the parent's card redraws and the model still receives
   * exactly one result.
   *
   * A promise-per-event rather than an unbounded queue on purpose: a snapshot
   * is a REPLACEMENT, not an entry in a log. If several steps land while the
   * consumer is away, the newest one is the only one worth drawing.
   */
  return async function* (
    input: INPUT,
    options: ToolExecutionOptions<unknown>,
  ): AsyncIterable<OUTPUT | PROGRESS> {
    let step = 0;
    let latest: PROGRESS | undefined;
    let wake: (() => void) | undefined;
    const onToolStart = (toolName: string, toolInput: unknown): void => {
      step += 1;
      const snapshot = report({ step, toolName, input: toolInput });
      if (snapshot === undefined) return;
      latest = snapshot;
      wake?.();
    };

    let settled = false;
    const finished = run(input, options, onToolStart).finally(() => {
      settled = true;
      wake?.();
    });

    while (!settled) {
      await Promise.race([
        finished.catch(() => undefined),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = undefined;
      if (settled) break;
      if (latest !== undefined) {
        yield latest;
        latest = undefined;
      }
    }
    // Awaited outside the race so a rejection still propagates to the guard.
    yield await finished;
  };
};
