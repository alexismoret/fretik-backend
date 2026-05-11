import { hasToolCall, stepCountIs, type PrepareStepFunction } from "ai";
import { z } from "zod";
import { chatModel, fallbackChatModel } from "../../lib/openrouter";
import {
  buildAgentSet,
  type AgentRuntimeContextBase,
} from "../shared/agent-builder";
import type { SearchableToolRegistry } from "../shared/chatbot-tool";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import { buildChatbotSystemPrompt } from "./system-prompt";
import { buildChatbotTools, type ChatbotTools } from "./tools";

/**
 * Maximum number of LLM steps the chatbot may take in a single turn,
 * tunable via `CHATBOT_MAX_STEPS` (default 30). Exposed as a knob so we
 * can tighten it for latency-sensitive workloads or loosen it for
 * long-horizon analyses without redeploying.
 *
 * The default of 30 leaves comfortable headroom for chained
 * tool-calling patterns (RAG → SQL → python → presentFiles + revisions)
 * while remaining a hard wall against runaway loops. Values that fall
 * outside `[1, 200]` are rejected at boot to avoid silent
 * misconfiguration.
 */
const parseChatbotMaxSteps = (): number => {
  const raw = process.env.CHATBOT_MAX_STEPS;
  if (raw === undefined || raw === "") return 30;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
    throw new Error(
      `Invalid CHATBOT_MAX_STEPS: "${raw}" — expected an integer in [1, 200].`,
    );
  }
  return parsed;
};

/**
 * Single source of truth for "what counts as a core tool name in the
 * chatbot tool set". Used by `chatbotPrepareStep` to compute
 * `activeTools` on every step. Also historically used as an
 * `initialActiveTools` hook for `buildAgentSet`, but that hook is
 * dead code in the chatbot flow because `prepareStep` runs on step
 * zero too and always overrides `activeTools`. Kept DRY here so any
 * future divergence between "initial" and "per-step" gating is an
 * intentional choice rather than an accidental drift.
 */
const computeCoreToolNames = (tools: ChatbotTools): (keyof ChatbotTools)[] => {
  const isToolName = (name: string): name is keyof ChatbotTools =>
    name in tools;
  const result: (keyof ChatbotTools)[] = [];
  for (const entry of Object.entries(tools)) {
    const [name, t] = entry;
    if (t.category === "core" && isToolName(name)) result.push(name);
  }
  return result;
};

/**
 * Chatbot agent — Fretik's general-purpose data assistant.
 *
 * Built once at module init via `buildAgentSet` (Phase 7.5). Exposes
 * a `{ primary, fallback }` pair of `ToolLoopAgent` singletons — the
 * handler tries `primary.stream()` first and falls back to
 * `fallback.stream()` on a primary error. Per-request state is
 * threaded through `experimental_context` via
 * `AgentRuntimeContext` (see `../shared/runtime-context.ts`).
 */

/**
 * Typed call options accepted by `chatbotAgentSet.primary/fallback.stream()`.
 * The handler constructs this from the Hono session (user-facing
 * route) or from the trusted `X-Context-*` headers (internal route)
 * and passes it as `.stream({ options: ... })`. The schema is
 * validated by the framework on every call before `prepareCall`
 * fires.
 */
export const ChatbotCallOptionsSchema = z.object({
  teamId: z.uuid(),
  organizationId: z.uuid(),
  userId: z.uuid().optional(),
  userName: z.string().optional(),
  conversationId: z.uuid().optional(),
  timeZone: z.string().optional(),
  /**
   * Pre-rendered fragment describing the files attached to the user
   * message being sent. The handler computes it by joining the last
   * user message's `file` parts against `ai_chat_files`; passed
   * through to `AgentRuntimeContext.attachedFilesBlock` and
   * substituted into the `{{attachedFilesBlock}}` placeholder in
   * system-prompt.md. Empty when no files are attached.
   */
  attachedFilesBlock: z.string().optional(),
  /**
   * Pre-rendered manifest of the persistent chatbot-context files
   * (Projects-style — user + team instructions and a compact catalogue
   * of files). Computed by the handler through
   * `buildChatbotContextManifest`. Threaded into
   * `AgentRuntimeContext.chatbotContextManifest` and substituted into
   * the `{{chatbotContextManifest}}` placeholder. Omitted when nothing
   * is configured for either scope.
   */
  chatbotContextManifest: z.string().optional(),
  /**
   * Per-turn trace id. The handler generates this at the start of
   * `runChatbotTurn` (typically reusing the resumable `streamId`) and
   * threads it through so every step / fallback / tool log carries the
   * same identifier. Lets us reconstruct a single user turn from the
   * container logs without correlating timestamps.
   */
  traceId: z.string().optional(),
});

export type ChatbotCallOptions = z.infer<typeof ChatbotCallOptionsSchema>;

/**
 * Narrow down `ChatbotTools` to the `{ name → SearchableTool }` shape
 * the prompt renderer consumes for the `{{deferredToolList}}`
 * placeholder. Single source of truth: any domain tool registered in
 * `buildDomainTools` shows up in the prompt automatically.
 *
 * Memoized per-tool-set-reference: the chatbot tool set is built once
 * at agent construction and never mutated, so we can cache the
 * derived registry behind a `WeakMap` keyed on the tool set. First
 * call does the filter; subsequent calls (one per turn through
 * `chatbotSystemPrompt`) hit the cache.
 */
const domainRegistryCache = new WeakMap<ChatbotTools, SearchableToolRegistry>();
const pickDomainRegistry = (tools: ChatbotTools): SearchableToolRegistry => {
  const cached = domainRegistryCache.get(tools);
  if (cached) return cached;
  const domainTools: SearchableToolRegistry = {};
  for (const [name, t] of Object.entries(tools)) {
    if (t.category === "domain") {
      domainTools[name] = {
        description: t.description,
        searchHint: t.searchHint,
        category: t.category,
      };
    }
  }
  domainRegistryCache.set(tools, domainTools);
  return domainTools;
};

/**
 * System prompt renderer wrapping `buildChatbotSystemPrompt`. Called
 * by `buildAgentSet`'s `prepareCall` on every turn with a fresh ctx.
 */
const chatbotSystemPrompt = (
  ctx: AgentRuntimeContext,
  tools: ChatbotTools,
): string => buildChatbotSystemPrompt(ctx, pickDomainRegistry(tools));

/**
 * Progressive Disclosure hook. Receives the static tool set at
 * construction, returns a `PrepareStepFunction` that reads the
 * runtime ctx via `getRuntimeContext` on every step. On each step it
 * recomputes `activeTools` as `[core tools..., activated domain tools...]`
 * based on the `DynamicToolManager`'s current snapshot.
 *
 * The core tool name list is precomputed once per agent instance —
 * the tool registry is immutable at runtime, so there's no point
 * filtering it on every step.
 */
const chatbotPrepareStep = (
  tools: ChatbotTools,
): PrepareStepFunction<ChatbotTools> => {
  const isToolName = (name: string): name is keyof ChatbotTools =>
    name in tools;
  const coreNames = computeCoreToolNames(tools);

  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    const activatedDomainNames = ctx.dynamicToolManager
      .getSnapshot()
      .filter(isToolName);
    return { activeTools: [...coreNames, ...activatedDomainNames] };
  };
};

/**
 * Map `ChatbotCallOptions` → the pure-data subset of
 * `AgentRuntimeContext`. `buildAgentSet` injects the per-request
 * managers (`dynamicToolManager`, `taskManager`) on top.
 */
const buildChatbotRuntimeContextBase = (
  options: ChatbotCallOptions,
): AgentRuntimeContextBase => ({
  organizationId: options.organizationId,
  teamId: options.teamId,
  userId: options.userId,
  userName: options.userName,
  conversationId: options.conversationId,
  timeZone: options.timeZone,
  attachedFilesBlock: options.attachedFilesBlock,
  chatbotContextManifest: options.chatbotContextManifest,
  traceId: options.traceId,
});

/**
 * The chatbot agent pair. Instantiated once at module init; reused
 * across every request. Handlers call
 * `chatbotAgentSet.primary.stream({ messages, options, abortSignal })`
 * with a try/catch falling back to `chatbotAgentSet.fallback.stream(...)`.
 */
// Note: we intentionally do NOT pass `initialActiveTools` here.
// `prepareStep` fires on every step including step 0 and always
// returns an explicit `{ activeTools }`, so any value supplied to
// `initialActiveTools` would be immediately overridden. Keeping the
// initial gating logic in one place (`chatbotPrepareStep`) avoids
// the risk of those two lists drifting apart over time. See the
// `computeCoreToolNames` docblock above for the DRY rationale.
export const chatbotAgentSet = buildAgentSet<ChatbotCallOptions, ChatbotTools>({
  id: "chatbot",
  buildTools: buildChatbotTools,
  systemPrompt: chatbotSystemPrompt,
  model: chatModel,
  fallbackModel: fallbackChatModel,
  // Stop the agent loop on either of two conditions:
  //   1. Hit the per-turn step budget (`CHATBOT_MAX_STEPS`, default 30).
  //   2. The model just called `askUserQuestion` — we MUST end the
  //      turn there because the tool's "answer" is provided out-of-band
  //      by the user via the UI on a future turn. Continuing past it
  //      would burn tokens generating filler text on top of an empty
  //      `answers: {}` payload, AND would risk the model
  //      hallucinating an answer in place of the user. The next turn
  //      starts fresh once the frontend posts the user's reply as a
  //      new user message.
  stopWhen: [
    stepCountIs(parseChatbotMaxSteps()),
    hasToolCall("askUserQuestion"),
  ],
  prepareStep: chatbotPrepareStep,
  buildRuntimeContextBase: buildChatbotRuntimeContextBase,
  callOptionsSchema: ChatbotCallOptionsSchema,
});
