import {
  ToolLoopAgent,
  isStepCount,
  type FlexibleSchema,
  type GenerateTextOnStepEndCallback,
  type LanguageModel,
  type PrepareStepFunction,
  type StopCondition,
  type ToolCallRepairFunction,
  type ToolLoopAgentSettings,
  type ToolSet,
} from "ai";
import { telemetryFor } from "../../lib/langfuse";
import {
  reasoningParamForProfile,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import type {
  ModelProfile,
  ReasoningLevel,
} from "../../lib/model-registry/types";
import { stopOnRepeatedToolErrors, trailingToolErrorRun } from "./agent-set";
import {
  DynamicToolManager,
  replayActivationFromHistory,
} from "./dynamic-tools";
import {
  tryGetRuntimeContext,
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "./runtime-context";

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
 *    handler, instantiates a fresh `DynamicToolManager`,
 *    assembles an `AgentRuntimeContext`, renders the
 *    system prompt against it, and returns the ctx (branded via
 *    `wrapRuntimeContext`) as the agent's `runtimeContext`; each
 *    `prepareStep` fans it out to every tool via `toolsContext`.
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
 * caller to derive from its `CALL_OPTIONS`. The per-request manager
 * (`dynamicToolManager`) is instantiated by the builder itself and
 * injected into the final ctx, so callers never deal with it.
 */
export type AgentRuntimeContextBase = Omit<
  AgentRuntimeContext,
  "dynamicToolManager" | "modelProfile"
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
  /**
   * System prompt renderer. Called on every `.stream()` via `prepareCall`.
   * May be async — managed-prompt renderers fetch from Langfuse (instant on
   * SDK cache hit) and `prepareCall` awaits the result.
   */
  systemPrompt: (
    ctx: AgentRuntimeContext,
    tools: TTools,
  ) => string | Promise<string>;
  /** Primary model, registry-resolved (instance + profile). */
  model: ResolvedModel;
  /** Fallback model, used when the primary errors out. */
  fallbackModel: ResolvedModel;
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
   * Optional wall-clock wrap-up steer — see `withSoftDeadline`. Set it on an
   * agent that runs under a dispatch `deadlineMs`, at ~75% of that budget,
   * with `text` saying what "land it now" means for THAT agent's job.
   */
  softDeadline?: { afterMs: number; text: string };
  /**
   * Map typed `CALL_OPTIONS` → the pure-data part of
   * `AgentRuntimeContext`. The builder appends
   * `dynamicToolManager` to finalise the ctx.
   */
  buildRuntimeContextBase: (options: CALL_OPTIONS) => AgentRuntimeContextBase;
  /**
   * Optional hook fired inside `prepareCall` right after the runtime ctx is
   * assembled (managers included) and BEFORE the system prompt renders. The
   * seam for per-call ctx preparation that needs the managers — e.g. the
   * workflow agent pre-activates the playbook's `toolHints` on
   * `ctx.dynamicToolManager` so hinted domain tools are live from step 0.
   * Mutations must respect the runtime-context mutation contract.
   */
  onRuntimeContext?: (ctx: AgentRuntimeContext, options: CALL_OPTIONS) => void;
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
   * Pass a custom function to silence the default.
   *
   * v7: this is the `onStepEnd` callback (the `onStepFinish` name is a
   * deprecated alias). It is a CONSTRUCTION-level setting — `prepareCall`
   * can no longer return it (callbacks are stripped from the prepareCall
   * channel and merged separately), so the per-request trace id is read
   * from `event.runtimeContext` instead of a closure.
   */
  onStepEnd?: GenerateTextOnStepEndCallback<TTools>;
  /**
   * Optional hard cap on tokens generated PER STEP. A step that hits the cap
   * ends with `finishReason: 'length'`: pure text stops the loop cleanly (the
   * partial survives in history, the next turn resumes it) — it does NOT fail
   * the run; a truncated tool-call surfaces as `InvalidToolInputError`, healed
   * by `repairToolCall` when set. Guards against a single runaway generation.
   *
   * IGNORED when the serving profile sets `provider.omitMaxTokens` — some
   * models' only ZDR-eligible upstream does not advertise the parameter, and
   * `require_parameters: true` turns an unsupported param into an EMPTY routing
   * pool (HTTP 404), not a dropped field. Losing a per-step cap is strictly
   * better than losing the model.
   */
  maxOutputTokens?: number;
  /**
   * Optional repair for a malformed tool call (`InvalidToolInputError` /
   * `NoSuchToolError`). Returning a fixed call retries it; returning `null`
   * falls back to the framework's default (surface the error to the model).
   */
  repairToolCall?: ToolCallRepairFunction<TTools>;
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
const defaultOnStepEnd = <TTools extends ToolSet>(
  agentId: string,
): GenerateTextOnStepEndCallback<TTools> => {
  return (event) => {
    // Per-request trace id, read from the step's runtime context (the
    // branded ctx `prepareCall` returned as `runtimeContext`). v7 strips
    // callbacks from the `prepareCall` channel, so the closure-captured
    // traceId of v6 is gone — the event carries it instead. Safe-read:
    // a logging callback must never crash a turn.
    const traceId = tryGetRuntimeContext({
      runtimeContext: event.runtimeContext,
    })?.traceId;
    const tracePrefix = traceId !== undefined ? ` trace=${traceId}` : "";
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

/**
 * Fan the per-request branded runtime context out to every tool name. AI SDK v7
 * delivers a tool's context ONLY through `toolsContext[toolName]`
 * (`ToolExecutionOptions` has no `runtimeContext`), so every concrete
 * `prepareStep` returns this map alongside `activeTools`. All entries point at
 * the SAME reference — which is also the agent's `runtimeContext` — so the
 * mutation contract holds (searchTools mutates mid-step, the next
 * `prepareStep` reads the mutation). Kept at the concrete tool-set call site
 * because `InferToolSetContext<TTools>` only reduces to the permissive `{}` for
 * the concrete, `contextSchema`-free registries — not under a generic `TTools`.
 */
export const buildToolsContext = (
  tools: ToolSet,
  ctx: AgentRuntimeContext,
): Record<string, AgentRuntimeContext> =>
  Object.fromEntries(Object.keys(tools).map((name) => [name, ctx]));

/**
 * Loop guard (applied to EVERY agent by `buildToolLoopAgent`): steer at 3
 * identical consecutive tool failures; circuit-break the TURN at 8 — a
 * backstop far above healthy operation (prod observed a 17-call
 * identical-failure loop with neither brake), same philosophy as the turn and
 * token caps. Ending the turn is not ending the work: a workflow run
 * re-steers on its next turn, a chat hands control back to the user.
 */
const LOOP_GUARD_STEER_AT = 3;
const LOOP_GUARD_ABORT_AT = 8;
/** Steer sooner for malformed-call-shape errors — one bad retry is enough. */
const LOOP_GUARD_INPUT_SHAPE_STEER_AT = 2;
/**
 * Error codes that mean "the CALL was shaped wrong", not "this tool can't do
 * the job". The fix is a corrected retry of the SAME tool from the error's
 * worked example — NEVER a switch to python (that manufactured the 35-python
 * loop in the 2026-07 DAE run, where the model abandoned `extract` after an
 * INVALID_SCHEMA instead of fixing the args).
 */
const INPUT_SHAPE_CODES = new Set([
  "INVALID_ARGS",
  "INVALID_SCHEMA",
  "INVALID_PAGE_RANGE",
]);

/**
 * Wrap an agent's `prepareStep` with the soft half of the loop guard: once the
 * trailing identical-failure run reaches the steer threshold, append ONE
 * transient user message telling the model to stop repeating the call. The
 * override carries forward within the turn and is never persisted (message
 * persistence flows from the UIMessage stream); dedup is by exact text, so
 * parallel failures that jump the counter past the threshold still inject
 * exactly once.
 */
const withLoopGuard = <TTools extends ToolSet>(
  base: PrepareStepFunction<TTools> | undefined,
): PrepareStepFunction<TTools> => {
  return async (options) => {
    const result = (await base?.(options)) ?? {};
    const run = trailingToolErrorRun(options.steps);
    if (!run) return result;
    const isInputShape = INPUT_SHAPE_CODES.has(run.code);
    const steerAt = isInputShape
      ? LOOP_GUARD_INPUT_SHAPE_STEER_AT
      : LOOP_GUARD_STEER_AT;
    if (run.count < steerAt) return result;
    // Input-shape errors: force a corrected retry of the SAME tool from the
    // hint's example — do NOT license switching tools. Other errors (the tool
    // genuinely can't proceed): the model may take a different route or report.
    const guardText = isInputShape
      ? `[loop-guard] Your ${run.toolName} calls keep failing with ${run.code} — the CALL is malformed, the tool is right. Retry ${run.toolName} ONCE using the exact shape from the error's hint (it shows a valid example). Do not switch to another tool.`
      : `[loop-guard] Your ${run.toolName} calls keep failing with ${run.code}. Do not repeat the same call: fix the input per the error's hint, take a different approach, or report the blocker (chat: tell the user; workflow run: completeTask failed).`;
    const messages = result.messages ?? options.messages;
    const alreadyInjected = messages.some(
      (message) => message.role === "user" && message.content === guardText,
    );
    if (alreadyInjected) return result;
    return {
      ...result,
      messages: [...messages, { role: "user" as const, content: guardText }],
    };
  };
};

/**
 * Wrap an agent's `prepareStep` with the reasoning-replay policy: when the
 * serving profile declares `reasoning.replayInHistory: false`, drop every
 * `reasoning` part from assistant messages before the step is sent. Text and
 * tool-call parts are untouched; an assistant message left empty by the strip
 * (reasoning-only, so it never carries tool calls whose responses could
 * desync) is dropped whole. Composed OUTSIDE the loop guard so it has the
 * final say on the outgoing messages.
 *
 * What this actually removes is the loop's OWN reasoning from earlier steps of
 * the SAME turn. Prior-turn reasoning never reaches here: it is stripped for
 * every profile, unconditionally, by `stripReasoningPartsForModel` inside
 * `prepareModelMessages`. See the flag's doc in `model-registry/types.ts`,
 * including why it should not be copied onto a new profile without measuring.
 */
export const withReasoningReplayStrip = <TTools extends ToolSet>(
  base: PrepareStepFunction<TTools>,
  profile: ModelProfile,
): PrepareStepFunction<TTools> => {
  if (profile.assessment.reasoning.replayInHistory !== false) return base;
  return async (options) => {
    const result = (await base(options)) ?? {};
    const messages = result.messages ?? options.messages;
    let changed = false;
    const stripped = messages.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [message];
      }
      const parts = message.content.filter((part) => part.type !== "reasoning");
      if (parts.length === message.content.length) return [message];
      changed = true;
      if (parts.length === 0) return [];
      return [{ ...message, content: parts }];
    });
    if (!changed) return result;
    return { ...result, messages: stripped };
  };
};

/**
 * Wrap an agent's `prepareStep` with a WALL-CLOCK steer: past `afterMs` of run
 * time, append one transient user message telling the model to wrap up. The
 * injection mechanics are `withLoopGuard`'s (transient user message, dedup by
 * exact text) — the workflow engine's `wrapUp` flag is the same idea but lives
 * in the handler because a workflow run re-enters between turns; a sub-agent's
 * generate loop never leaves its tool call, so the steer must ride a step.
 *
 * This is the soft half of a dispatch deadline. The hard half
 * (`createSubAgentExecute.deadlineMs`) is an AbortSignal that cuts mid-
 * generation and throws away whatever was in flight — measured 2026-08-23,
 * two of three page builds died at exactly 900s with a paid, half-streamed
 * generation and left the parent to redo the closing review. A model told at
 * 75% of the budget to land what it has turns that cliff into an ending.
 *
 * Anchored on the FIRST step's response timestamp rather than a closure: the
 * agent is a singleton shared by concurrent runs, so per-run state cannot
 * live in the wrapper. The anchor misses the first generation's duration,
 * which only makes the steer later, never earlier.
 */
export const withSoftDeadline = <TTools extends ToolSet>(
  base: PrepareStepFunction<TTools>,
  soft: { afterMs: number; text: string } | undefined,
): PrepareStepFunction<TTools> => {
  if (!soft) return base;
  return async (options) => {
    const result = (await base(options)) ?? {};
    const anchor = options.steps[0]?.response.timestamp;
    if (!anchor || Date.now() - anchor.getTime() < soft.afterMs) return result;
    const messages = result.messages ?? options.messages;
    const alreadyInjected = messages.some(
      (message) => message.role === "user" && message.content === soft.text,
    );
    if (alreadyInjected) return result;
    return {
      ...result,
      messages: [...messages, { role: "user" as const, content: soft.text }],
    };
  };
};

/**
 * The argument type the framework hands to `prepareCall` — derived from the
 * SDK settings so the callback body stays fully typed even though the settings
 * object is asserted past the generic `ToolsContextParameter` conditional.
 */
type PrepareCallArgs<CALL_OPTIONS, TTools extends ToolSet> = Parameters<
  NonNullable<ToolLoopAgentSettings<CALL_OPTIONS, TTools>["prepareCall"]>
>[0];

const buildToolLoopAgent = <CALL_OPTIONS, TTools extends ToolSet>(
  config: BuildAgentSetConfig<CALL_OPTIONS, TTools>,
  resolved: ResolvedModel,
): ToolLoopAgent<CALL_OPTIONS, TTools> => {
  const model: LanguageModel = resolved.model;
  const tools = config.buildTools();
  const prepareStep = withSoftDeadline(
    withReasoningReplayStrip(
      withLoopGuard(config.prepareStep?.(tools)),
      resolved.profile,
    ),
    config.softDeadline,
  );
  const configuredStop = config.stopWhen ?? isStepCount(12);
  // Compose the loop guard's hard backstop into every agent's stop set.
  const stopWhen = [
    ...(Array.isArray(configuredStop) ? configuredStop : [configuredStop]),
    stopOnRepeatedToolErrors<TTools>(LOOP_GUARD_ABORT_AT),
  ];
  const onStepEnd = config.onStepEnd ?? defaultOnStepEnd<TTools>(config.id);
  // Step-0 fallback tool menu for agents WITHOUT a Progressive-Disclosure
  // `prepareStep` (all tools active). Every Fretik agent DOES set a
  // `prepareStep` — which fires on step 0 too and supersedes this — so the
  // fallback is only the type-level default for a prepareStep-less agent.
  //
  // Tool-context fan-out (v7): a tool's context arrives ONLY through
  // `toolsContext[toolName]` (`ToolExecutionOptions` has no `runtimeContext`),
  // so each agent's concrete `prepareStep` returns a `toolsContext` mapping
  // every tool name to the branded ctx via `buildToolsContext` — done at the
  // concrete tool-set site because `InferToolSetContext<TTools>` only reduces
  // to the permissive `{}` there, not under the generic `TTools`.
  const hasPrepareStep = prepareStep !== undefined;
  const fallbackActiveTools = Object.keys(tools) as (keyof TTools)[];

  // `ToolLoopAgentSettings` intersects a distributive conditional
  // `ToolsContextParameter<TTools>` (`IsEmptyObject<InferToolSetContext<TTools>>
  // extends true ? { toolsContext?: never } : { toolsContext: … }`). For a
  // GENERIC `TTools` that conditional is unresolvable, so TS cannot prove this
  // settings object — which supplies no per-tool `toolsContext` because Fretik
  // tools declare no `contextSchema` — satisfies it, even though it does at
  // every concrete instantiation (`buildAgentSet<…, ChatbotToolSet>`). The cast
  // below absorbs that generic-only limitation; every field value is still
  // individually typed via the vars it references, and the runtime shape is
  // unchanged. Same sanctioned SDK-type-erasure escape hatch as the brand cast
  // in `runtime-context.ts` and the guard cast in `chatbot-tool.ts`.
  return new ToolLoopAgent<CALL_OPTIONS, TTools>({
    id: config.id,
    model,
    tools,
    stopWhen,
    prepareStep,
    onStepEnd,
    callOptionsSchema: config.callOptionsSchema,
    // `omitMaxTokens` wins over the configured cap — see the field's docblock.
    // Probed 2026-07-26: OpenAI's ZDR endpoints are served by Azure, which
    // advertises `max_completion_tokens` rather than `max_tokens`, so sending
    // one under `require_parameters: true` + `zdr: true` empties the pool and
    // OpenRouter answers 404 "No endpoints found matching your data policy".
    ...(config.maxOutputTokens !== undefined &&
    resolved.profile.assessment.provider.omitMaxTokens !== true
      ? { maxOutputTokens: config.maxOutputTokens }
      : {}),
    ...(config.repairToolCall !== undefined
      ? { experimental_repairToolCall: config.repairToolCall }
      : {}),
    // Langfuse tracing: the `@langfuse/vercel-ai-sdk` integration turns
    // these AI-SDK telemetry events into costed Langfuse observations.
    // `includeRuntimeContext: { langfusePrompt: true }` opts the per-request
    // `ctx.langfusePrompt` ({ name, version }) into telemetry so the
    // integration links each generation to its managed prompt version (v7's
    // replacement for v6's `telemetry.metadata.langfusePrompt`); no other ctx
    // key is exposed. `prepareCall` spreads `...baseCallArgs` (which carries
    // this setting) under v7's REPLACE semantics. No-op when Langfuse is off.
    telemetry: telemetryFor(`agent:${config.id}`, {
      langfusePrompt: true,
    }),
    // `baseCallArgs` is annotated explicitly because the settings object is
    // asserted (`as unknown as` below, to absorb the generic `ToolsContextParameter`
    // conditional), which strips the contextual typing the callback would
    // otherwise inherit.
    prepareCall: async (
      baseCallArgs: PrepareCallArgs<CALL_OPTIONS, TTools>,
    ) => {
      // v7 `prepareCall` still REPLACES the call settings wholesale
      // (`preparedCallArgs = (await prepareCall(baseCallArgs)) ?? baseCallArgs`
      // — verified in `ai@7` `dist/index.js`), so we spread `...baseCallArgs`
      // first and override only the per-request deltas. Lifecycle callbacks
      // (`onStepEnd`, `onFinish`, …) are the exception: v7 strips them from
      // this channel and merges them separately, so they are NOT returnable
      // here — the construction-level `onStepEnd` reads the per-request trace
      // id from `event.runtimeContext` instead of a closure.
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
        // The profile of THIS instance's model — the fallback agent
        // carries the fallback profile, so capability-aware reads
        // (modalities, strict schemas, compaction) always describe the
        // model actually serving the call.
        modelProfile: resolved.profile,
      };
      config.onRuntimeContext?.(ctx, options);
      const instructions = await config.systemPrompt(ctx, tools);
      const branded = wrapRuntimeContext(ctx);

      // Hand the per-request branded ctx to the framework as `runtimeContext`
      // (v7's shared-orchestration channel, in the `prepareCall` return Pick).
      // `prepareStep` fans it out to every tool via `toolsContext`; the
      // construction-level `onStepEnd` reads it from `event.runtimeContext`.
      // The Langfuse prompt-version link (`ctx.langfusePromptLink`) is surfaced
      // to telemetry in WS2 via `telemetry.includeRuntimeContext` — v7's
      // `TelemetryOptions` no longer carries a `metadata` field.
      // Thinking depth for a DELEGATE. A top-level turn puts its own reasoning
      // param on the wire at `.stream()` and arrives here with it already in
      // `baseCallArgs`; a sub-agent has no such caller, so before 2026-08-18 it
      // silently ran at its profile's default however deeply the user had asked
      // the turn to think. Applied only when the ctx carries a level AND the
      // caller set none — `prepareCall` REPLACES call settings wholesale, so
      // overriding a param the caller chose would be the same bug in reverse.
      const reasoning =
        ctx.reasoningLevel !== undefined &&
        baseCallArgs.providerOptions === undefined
          ? reasoningParamForProfile(
              resolved.profile,
              ctx.reasoningLevel as ReasoningLevel,
            )
          : undefined;

      return {
        ...baseCallArgs,
        instructions,
        runtimeContext: branded,
        ...(reasoning !== undefined
          ? { providerOptions: { openrouter: { reasoning } } }
          : {}),
        // Fallback `activeTools` for agents WITHOUT a `prepareStep`. When a
        // `prepareStep` is set it fires on step 0 and supersedes this.
        ...(hasPrepareStep ? {} : { activeTools: fallbackActiveTools }),
      };
    },
  } as unknown as ToolLoopAgentSettings<CALL_OPTIONS, TTools>);
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
