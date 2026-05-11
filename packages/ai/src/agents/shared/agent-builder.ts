import {
  ToolLoopAgent,
  stepCountIs,
  type FlexibleSchema,
  type LanguageModel,
  type PrepareStepFunction,
  type StopCondition,
  type ToolLoopAgentOnStepFinishCallback,
  type ToolSet,
} from "ai";
import {
  DynamicToolManager,
  replayActivationFromHistory,
} from "./dynamic-tools";
import {
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "./runtime-context";
import { TaskManager } from "./task-manager";

/**
 * Factory for a pair of `ToolLoopAgent` singletons (primary + fallback)
 * wired to the Fretik runtime-context DI. Replaces the hand-rolled
 * `createAgent` factory from Phases 1-7d.
 *
 * Design notes (Phase 7.5):
 *
 * 1. Both agents share the exact same tool set, system prompt, stop
 *    condition and `prepareStep` hook — only the `model` differs.
 *    The handler tries `.primary.stream(...)` first and falls back
 *    to `.fallback.stream(...)` on failure. Behaviour is identical
 *    to the old try/catch inside `createAgent.run`, just moved up a
 *    level so the agent instances themselves stay stateless and
 *    reusable across every request.
 *
 * 2. `prepareCall` is where per-request state is born. It receives
 *    the typed `CALL_OPTIONS` (e.g. `ChatbotCallOptions`) from the
 *    handler, instantiates a fresh `DynamicToolManager` +
 *    `TaskManager`, assembles an `AgentRuntimeContext`, renders the
 *    system prompt against it, and hands the ctx off through
 *    `experimental_context` (branded via `wrapRuntimeContext` so
 *    tools can recover it without an `as` cast).
 *
 * 3. `prepareStep` is handed the static tool set at construction and
 *    returns a `PrepareStepFunction` that reads the runtime ctx via
 *    `getRuntimeContext(stepContext)` at step time. This is where
 *    Progressive Disclosure lives — see `chatbot/index.ts`.
 *
 * 4. Tools MUST NOT close over per-request state. Closures would
 *    leak state across concurrent requests on the singleton agent
 *    instance. This file is the single place that couples per-
 *    request state to the framework.
 */

/**
 * Subset of `AgentRuntimeContext` that `buildAgentSet` expects the
 * caller to derive from its `CALL_OPTIONS`. The two per-request
 * managers (`dynamicToolManager`, `taskManager`) are instantiated by
 * the builder itself and injected into the final ctx, so callers
 * never deal with them.
 */
export type AgentRuntimeContextBase = Omit<
  AgentRuntimeContext,
  "dynamicToolManager" | "taskManager"
>;

/**
 * Configuration for a single agent kind. Two `ToolLoopAgent`
 * instances are constructed from this config: one with `model`, one
 * with `fallbackModel`. All other settings are shared.
 */
export interface BuildAgentSetConfig<CALL_OPTIONS, TTools extends ToolSet> {
  /** Short identifier, used in logs and traces. */
  id: string;
  /**
   * Construct the static tool set. Called once per agent instance at
   * boot. Tools MUST be ctx-less (see `../../tools/README.md`).
   */
  buildTools: () => TTools;
  /** System prompt renderer. Called on every `.stream()` via `prepareCall`. */
  systemPrompt: (ctx: AgentRuntimeContext, tools: TTools) => string;
  /** Primary language model. */
  model: LanguageModel;
  /** Fallback language model, used when the primary errors out. */
  fallbackModel: LanguageModel;
  /**
   * Optional stop condition. Defaults to `stepCountIs(12)` — mirrors
   * the previous `maxSteps: 12` default from Phase 1.
   */
  stopWhen?: StopCondition<TTools> | Array<StopCondition<TTools>>;
  /**
   * Optional factory that builds the per-step hook from the static
   * tool set. Receives `tools` so it can close over them for O(1)
   * lookups; must read the runtime ctx via `getRuntimeContext` at
   * step time (never capture per-request state in its closure).
   */
  prepareStep?: (tools: TTools) => PrepareStepFunction<TTools>;
  /**
   * Optional hook that computes the initial `activeTools` list
   * returned by `prepareCall` on every turn. Defaults to all tool
   * names (= no gating). The chatbot overrides this to return only
   * `category === "core"` tools so Progressive Disclosure (Phase 2)
   * stays gated until `searchTools` activates a domain tool.
   */
  initialActiveTools?: (tools: TTools) => (keyof TTools)[];
  /**
   * Map typed `CALL_OPTIONS` → the pure-data part of
   * `AgentRuntimeContext`. The builder appends
   * `dynamicToolManager` + `taskManager` to finalise the ctx.
   */
  buildRuntimeContextBase: (options: CALL_OPTIONS) => AgentRuntimeContextBase;
  /**
   * Optional Zod (or compatible) schema validated by the framework
   * on every `.stream()` / `.generate()` call. Keeps runtime
   * drift from leaking into tool executions.
   */
  callOptionsSchema?: FlexibleSchema<CALL_OPTIONS>;
  /**
   * Optional per-step observability hook. Called by the AI SDK
   * after every step completes (including intermediate tool-use
   * steps). When omitted, a default structured logger emits
   * `[agent:{id}] step N tools=[...] duration=Xms reason=Y` to
   * `console.info` so every turn leaves a minimal step trace in
   * the container logs without the caller having to wire anything.
   * Pass a custom function (or explicit `null` via an override) to
   * silence the default.
   */
  onStepFinish?: ToolLoopAgentOnStepFinishCallback<TTools>;
}

/**
 * Output shape of `buildAgentSet`. `primary` + `fallback` are
 * stand-alone `ToolLoopAgent` instances (both implement the
 * `Agent<CALL_OPTIONS, TOOLS, OUTPUT>` interface). `toolNames` is a
 * convenience snapshot of the tool registry's keys — useful for
 * handlers that need to advertise the tool catalog without
 * reconstructing it.
 */
export interface AgentSet<CALL_OPTIONS, TTools extends ToolSet> {
  primary: ToolLoopAgent<CALL_OPTIONS, TTools>;
  fallback: ToolLoopAgent<CALL_OPTIONS, TTools>;
  toolNames: (keyof TTools)[];
}

/**
 * Default `onStepFinish` handler — emits one line per step with
 * agent id, step number, tool names called, token usage, and the
 * finish reason. Cheap (<1µs of formatting) and gives every turn a
 * minimal step trace without the caller having to wire anything.
 *
 * Wall-clock duration is NOT surfaced on `StepResult` in AI SDK v6,
 * so downstream log processors should derive it from the timestamp
 * delta between consecutive step lines (or from the container's
 * log ingestion layer).
 *
 * **Cache observability (Sprint A — plan §3.2).** When the provider
 * surfaces `inputTokenDetails.cacheReadTokens` / `cacheWriteTokens`,
 * the line includes `cacheRead=N cacheWrite=M cacheRatio=R%` so we
 * can verify implicit prompt caching is firing on the static prefix
 * without standing up a metrics pipeline. OpenAI / DeepSeek / Gemini
 * (via OpenRouter) populate these fields automatically; MiniMax
 * routes do not surface them today, so the line gracefully falls
 * back to the original `tokens=N` shape when the details are
 * missing. Pure read-only logging — no behaviour change.
 */
const defaultOnStepFinish = <TTools extends ToolSet>(
  agentId: string,
  /**
   * Optional per-request trace id captured by the closure inside
   * `prepareCall`. When set, prefixes every step log + zombie warning
   * with `trace=<id>` so a single user turn can be reconstructed end-
   * to-end from the container logs without correlating timestamps.
   * Safe to capture in a closure even though the agent is a singleton:
   * `prepareCall` runs once per request, so each request gets a fresh
   * onStepFinish carrying its own traceId.
   */
  traceId?: string,
): ToolLoopAgentOnStepFinishCallback<TTools> => {
  const tracePrefix = traceId !== undefined ? ` trace=${traceId}` : "";
  return (event) => {
    const toolNames = event.toolCalls.map((c) => c.toolName).join(",") || "-";
    const usage = event.usage;
    const cacheRead = usage?.inputTokenDetails?.cacheReadTokens;
    const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens;
    const inputTokens = usage?.inputTokens;
    const usageParts: string[] = [];
    if (usage?.totalTokens !== undefined) {
      usageParts.push(`tokens=${usage.totalTokens}`);
    } else {
      usageParts.push("tokens=?");
    }
    if (cacheRead !== undefined) {
      usageParts.push(`cacheRead=${cacheRead}`);
    }
    if (cacheWrite !== undefined) {
      usageParts.push(`cacheWrite=${cacheWrite}`);
    }
    if (
      cacheRead !== undefined &&
      inputTokens !== undefined &&
      inputTokens > 0
    ) {
      const ratio = Math.round((cacheRead / inputTokens) * 100);
      usageParts.push(`cacheRatio=${ratio}%`);
    }
    console.info(
      `[agent:${agentId}]${tracePrefix} step=${event.stepNumber} model=${event.model.modelId} tools=[${toolNames}] finish=${event.finishReason} ${usageParts.join(" ")}`,
    );

    // Telemetry-only signal for the "reasoning-only zombie" pattern:
    // the model burned its output budget on hidden chain-of-thought
    // (`finishReason: other|length`), produced no tool call and no
    // visible text. We log it so dashboards can alert on a rising
    // zombie rate; the user-facing remediation (synthetic message +
    // fallback retry) lives in `handlers/chatbot.ts` where the merge
    // happens. Throwing here is pointless — `streamText` swallows the
    // throw and surfaces a "clean" finish=other, never reaching the
    // outer `onError`.
    const isBudgetExhausted =
      event.finishReason === "other" || event.finishReason === "length";
    const hasNoToolCalls = event.toolCalls.length === 0;
    const hasNoVisibleText = event.text.length === 0;
    if (isBudgetExhausted && hasNoToolCalls && hasNoVisibleText) {
      const reasoningTokens =
        typeof usage?.outputTokenDetails?.reasoningTokens === "number"
          ? usage.outputTokenDetails.reasoningTokens
          : undefined;
      console.error(
        `[agent:${agentId}]${tracePrefix} reasoning-only zombie step detected — finish=${event.finishReason} reasoningTokens=${reasoningTokens?.toString() ?? "?"}`,
      );
    }
  };
};

const buildToolLoopAgent = <CALL_OPTIONS, TTools extends ToolSet>(
  config: BuildAgentSetConfig<CALL_OPTIONS, TTools>,
  model: LanguageModel,
): ToolLoopAgent<CALL_OPTIONS, TTools> => {
  const tools = config.buildTools();
  const prepareStep = config.prepareStep?.(tools);
  const stopWhen = config.stopWhen ?? stepCountIs(12);
  const onStepFinish =
    config.onStepFinish ?? defaultOnStepFinish<TTools>(config.id);
  // `initialActiveTools` is an escape hatch for agents that do NOT
  // set a `prepareStep` hook. When both are set, prepareStep runs on
  // step 0 too and overrides whatever prepareCall returns — the
  // chatbot relies on this and omits the hook entirely. Default
  // (when neither is set): all tools active.
  const hasPrepareStep = prepareStep !== undefined;
  const fallbackActiveTools = config.initialActiveTools
    ? config.initialActiveTools(tools)
    : (Object.keys(tools) as (keyof TTools)[]);

  return new ToolLoopAgent<CALL_OPTIONS, TTools>({
    id: config.id,
    model,
    tools,
    stopWhen,
    prepareStep,
    onStepFinish,
    callOptionsSchema: config.callOptionsSchema,
    prepareCall: (baseCallArgs) => {
      // **Critical semantics of `ToolLoopAgent.prepareCall`**: the
      // return value is **NOT** merged with the agent's construction
      // settings — it REPLACES them wholesale before being forwarded
      // to `streamText` / `generateText`. See the AI SDK source at
      // `ai/dist/index.mjs:8116`:
      //
      //     const preparedCallArgs =
      //       (await this.settings.prepareCall?.(baseCallArgs))
      //       ?? baseCallArgs;
      //
      // If our callback returns any non-null object, that object is
      // used as-is. The type system's `Pick<ToolLoopAgentSettings, ...>`
      // return type looks permissive (all fields optional), but any
      // field we omit from the return is LOST. Specifically: `tools`,
      // `prepareStep`, `stopWhen`, `onStepFinish`, `callOptionsSchema`
      // are all dropped if we don't re-emit them. This is the exact
      // regression that shipped in Phase 7.5 and caused the 2026-04-16
      // "No tools are available" failure across MiniMax, GPT-5-mini
      // and every other model — `reqTools=<no-field>` in the logs and
      // `prepareStep` never fired because none of those fields made
      // it into the downstream `streamText` call.
      //
      // Fix: spread `baseCallArgs` first, then override only the
      // fields we actually want to customize (instructions,
      // experimental_context, activeTools when there's no
      // prepareStep). This mirrors what the default (no-op) branch
      // would return if `prepareCall` were not set at all.
      //
      // `baseCallArgs` is assembled by the agent at `index.mjs:8110`
      // as `{ ...settingsWithoutCallback, stopWhen, ...agentCallParams }`.
      // It is a flat object containing every agent setting plus the
      // per-call `{ options, messages|prompt, abortSignal, timeout }`.
      const { options, messages } = baseCallArgs;
      if (options === undefined) {
        // `AgentCallParameters.options` is only optional at the type
        // level when `CALL_OPTIONS = never`. Every agent in Fretik
        // declares a `callOptionsSchema`, so by the time the
        // framework reaches `prepareCall` the options have already
        // been validated and populated. Anything reaching this
        // branch is a framework-level bug and must fail loudly.
        throw new Error(
          `Agent "${config.id}" invoked without call options — expected typed CALL_OPTIONS.`,
        );
      }
      const base = config.buildRuntimeContextBase(options);
      const dynamicToolManager = new DynamicToolManager();
      // Replay Progressive Disclosure state from prior turns in this
      // conversation — without this, every new user message starts
      // with an empty activated set and the model has to re-discover
      // every domain tool it already used. Mirrors Claude Code's
      // `extractDiscoveredToolNames` pattern. When `messages` is
      // absent (caller passed `prompt` instead) the replay is a
      // no-op.
      if (messages !== undefined) {
        replayActivationFromHistory(
          dynamicToolManager,
          messages,
          "searchTools",
        );
      }
      const ctx: AgentRuntimeContext = {
        ...base,
        dynamicToolManager,
        taskManager: new TaskManager(),
      };
      const instructions = config.systemPrompt(ctx, tools);
      const branded = wrapRuntimeContext(ctx);

      // Per-request `onStepFinish` so step + zombie log lines can
      // carry the runtime ctx's `traceId`. The closure is created
      // here (per-request inside `prepareCall`), not on the singleton
      // agent — no cross-request leakage. If the caller passed a
      // custom `config.onStepFinish` we honour it as-is (they're then
      // responsible for surfacing traceId themselves).
      const stepFinishOverride =
        config.onStepFinish === undefined && ctx.traceId !== undefined
          ? defaultOnStepFinish<TTools>(config.id, ctx.traceId)
          : undefined;

      return {
        ...baseCallArgs,
        instructions,
        experimental_context: branded,
        ...(stepFinishOverride !== undefined
          ? { onStepFinish: stepFinishOverride }
          : {}),
        // Keep the fallback `activeTools` override when there is no
        // `prepareStep`. When `prepareStep` IS set, it will fire on
        // every step (including step 0) and override whatever we put
        // here — so leaving `activeTools` out of this branch would be
        // equivalent. We set it conditionally to keep the intent
        // explicit.
        ...(hasPrepareStep ? {} : { activeTools: fallbackActiveTools }),
      };
    },
  });
};

/**
 * Build a `{ primary, fallback }` agent pair. Call once per agent
 * kind at module init — the resulting instances are reusable across
 * every request.
 */
export const buildAgentSet = <CALL_OPTIONS, TTools extends ToolSet>(
  config: BuildAgentSetConfig<CALL_OPTIONS, TTools>,
): AgentSet<CALL_OPTIONS, TTools> => {
  const primary = buildToolLoopAgent(config, config.model);
  const fallback = buildToolLoopAgent(config, config.fallbackModel);
  const toolNames = Object.keys(primary.tools) as (keyof TTools)[];
  return { primary, fallback, toolNames };
};
