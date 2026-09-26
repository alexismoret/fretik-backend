import { hasToolCall, isStepCount, type PrepareStepFunction } from "ai";
import {
  resolveChatModelForProfile,
  resolveModel,
  resolvePageBuildModelForProfile,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import { isWebToolAvailable, WEB_TOOL_NAMES } from "../../lib/web-egress";
import { PAGE_BUILDER_AGENT_ID } from "../../services/page-project/build";
import { pageBuilderHiddenTools } from "../../services/page-project/build-gate";
import type { PrunePricing } from "../../services/page-project/prune-history";
import { prunePageWriteHistory } from "../../services/page-project/prune-history";
import { salvagePageProject } from "../../services/page-project/salvage";
import { createBuildPageTool } from "../../tools/build-page";
import {
  AGENT_STEP_MAX_OUTPUT_TOKENS,
  buildAgentSet,
  buildToolsContext,
  type AgentSet,
} from "../shared/agent-builder";
import { memoizeAgentSets, stopOnPendingApproval } from "../shared/agent-set";
import { parseIntEnv } from "../shared/env";
import { policyHiddenToolNames } from "../shared/policy-tool-gate";
import {
  computeCoreToolNames,
  pickDomainRegistry,
  progressiveActiveTools,
} from "../shared/progressive-disclosure";
import { buildPageBuilderSystemPrompt } from "../shared/prompt-renderer";
import { llmRepairToolCall } from "../shared/repair-tool-call";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import type { RenderedAgentPrompt } from "../shared/turn-context";
import { buildChatbotSystemPrompt } from "./system-prompt";
import {
  buildChatbotTools,
  buildPageBuilderTools,
  type ChatbotTools,
  type PageBuilderTools,
} from "./tools";

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
const parseChatbotMaxSteps = (): number =>
  parseIntEnv("CHATBOT_MAX_STEPS", { fallback: 30, min: 1, max: 200 });
/**
 * A web tool is suppressed when an operator sets `AI_WEB_TOOLS_ENABLED=false`
 * or its own backend has no key — per tool, not as a block, because the three
 * no longer share a provider (`isWebToolAvailable` in `lib/web-egress.ts`,
 * which also owns the canonical name list). A deployment with a search key and
 * no fetch key keeps `searchWeb`. Passing this as the `suppress` gate to the
 * shared Progressive-Disclosure helpers keeps a suppressed tool out of both
 * `activeTools` and the prompt's domain-tool catalogue, so the model never sees
 * a tool it cannot use.
 */
const isToolSuppressed = (name: string): boolean =>
  WEB_TOOL_NAMES.has(name) && !isWebToolAvailable(name);

/**
 * Chatbot agent — Fretik's general-purpose data assistant.
 *
 * Built once at module init via `buildAgentSet` (Phase 7.5). Exposes
 * a `{ primary, fallback }` pair of `ToolLoopAgent` singletons — the
 * handler tries `primary.stream()` first and falls back to
 * `fallback.stream()` on a primary error. Per-request state is
 * carried by `AgentRuntimeContext` (the agent's `runtimeContext`, fanned
 * out to tools via `toolsContext` — see `../shared/runtime-context.ts`).
 */

import {
  buildChatbotRuntimeContextBase,
  ChatbotCallOptionsSchema,
  type ChatbotCallOptions,
} from "./call-options";
import { delegateHiddenToolNames, dispatchAgentTool } from "./delegate";
import { chatbotHiddenToolNames } from "./hidden-tools";

export {
  buildChatbotRuntimeContextBase,
  ChatbotCallOptionsSchema,
  type ChatbotCallOptions,
} from "./call-options";
export { dispatchAgentTool } from "./delegate";

/**
 * System prompt renderer wrapping `buildChatbotSystemPrompt`. Called
 * by `buildAgentSet`'s `prepareCall` on every turn with a fresh ctx.
 * The domain-tool registry (for the `{{deferredToolList}}` placeholder) is
 * filtered by the shared `pickDomainRegistry`, minus the web tools when
 * disabled — memoized per tool-set reference so per-turn renders hit the cache.
 */
const chatbotSystemPrompt = (
  ctx: AgentRuntimeContext,
  tools: ChatbotTools,
): Promise<RenderedAgentPrompt> => {
  // `pickDomainRegistry` is memoized on the static tool set, so per-team policy
  // filtering happens HERE (downstream) — a `blocked` domain tool must not
  // appear in `{{deferredToolList}}`.
  const domain = pickDomainRegistry(tools, isToolSuppressed);
  const hidden = policyHiddenToolNames(ctx);
  const visible =
    hidden.size === 0
      ? domain
      : Object.fromEntries(
          Object.entries(domain).filter(([name]) => !hidden.has(name)),
        );
  return buildChatbotSystemPrompt(ctx, visible);
};

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
  const coreNames = computeCoreToolNames(tools, isToolSuppressed);

  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    return {
      activeTools: progressiveActiveTools(
        ctx,
        tools,
        coreNames,
        chatbotHiddenToolNames(ctx),
      ),
      toolsContext: buildToolsContext(tools, ctx),
    };
  };
};

/**
 * What `prunePageWriteHistory` needs to know about the model that will read
 * the pruned history. Read from the SERVING model, which `buildAgentSet` hands
 * to the factory per instance — built once from the primary's profile, the
 * fallback agent pruned on the wrong cache prices (2026-09-14).
 */
export const prunePricingFor = (model: ResolvedModel): PrunePricing => ({
  contextTokens: model.profile.catalog.contextLength,
  inputPerMTok: model.profile.assessment.pricing.inputPerMTok,
  ...(model.profile.assessment.pricing.cacheReadPerMTok !== undefined
    ? { cacheReadPerMTok: model.profile.assessment.pricing.cacheReadPerMTok }
    : {}),
});

/**
 * The page builder's gate — same contract, its own concrete tool set, plus the
 * one thing only this agent needs: its own write history, minus the file bodies
 * it has already replaced.
 *
 * The pricing comes from the model actually serving this build rather than
 * from a constant, because whether dropping a body is a saving or a loss is a
 * property of that model's cache. See `prunePageWriteHistory` for the
 * measurement on both sides.
 *
 * It also retires `pageBuild` after the first review, which is where the
 * builder was spending about a sixth of its steps on a call `pageReview`
 * already makes. See `reviewHasRun`.
 */
const pageBuilderPrepareStep = (
  tools: PageBuilderTools,
  model: ResolvedModel,
): PrepareStepFunction<PageBuilderTools> => {
  const allNames = Object.keys(tools) as (keyof PageBuilderTools)[];
  const pricing = prunePricingFor(model);
  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    const hidden = pageBuilderHiddenTools(
      delegateHiddenToolNames(ctx),
      stepContext.messages,
    );
    const pruned = prunePageWriteHistory(stepContext.messages, pricing);
    return {
      activeTools: allNames.filter((name) => !hidden.has(name)),
      toolsContext: buildToolsContext(tools, ctx),
      // Omitted when nothing was superseded: an override is carried forward
      // by the SDK, and handing it an identical copy every step buys nothing.
      ...(pruned !== null ? { messages: pruned } : {}),
    };
  };
};

/**
 * Page-builder step budget. Higher than the generic sub-agent's 25 because a
 * build is a PIPELINE, not a task: probe, brief, component APIs (up to 6 per
 * call), a write per file, a build, then the review loop. At 25 the loop would
 * run out of budget precisely during the reviews — the part that makes the page
 * good. Tunable via `PAGE_BUILDER_MAX_STEPS`.
 *
 * 45 → 80 on 2026-09-03, when a page became a project: the same page now costs
 * one step per file instead of one whole-file emission, so the step count went
 * up while the TOKENS per step went down by roughly a factor of eight. Steps
 * are the cheap axis — an 80-step build of 3 000-token writes is a fraction of
 * a 45-step build of 25 000-token ones.
 */
const parsePageBuilderMaxSteps = (): number =>
  parseIntEnv("PAGE_BUILDER_MAX_STEPS", { fallback: 80, min: 1, max: 160 });

const pageBuilderSystemPrompt = (ctx: AgentRuntimeContext): Promise<string> =>
  buildPageBuilderSystemPrompt(ctx);

/**
 * Page-builder agent set — the third delegate, reached through the `buildPage`
 * tool and nothing else (`dispatchAgent` has no route to it). Since
 * 2026-08-21 that door is also the ONLY way a page gets authored at all: no
 * other agent has the `page*` tools, and `managePage` cannot author.
 *
 * On the PRIMARY model, never the cheap one: it writes a Vue project file by
 * file and then reads a design critique of it. Its tool registry is a short positive
 * list (`buildPageBuilderTools`), so no gating hook is needed — every tool it
 * has, it may call on every step. The team policy gate still applies, which is
 * why it shares `delegateHiddenToolNames`: a team that disabled `managePage` must
 * not get pages through a delegate.
 *
 * DELIBERATELY WITHOUT the per-step output cap the chat and sub-agent sets
 * carry. It writes several files in one step, so its legitimate generation is
 * the widest on this path — and the 2026-09-20 sample that fixed 32 000 as a
 * safe ceiling contains no page build, so applying that number here would be
 * guessing with a truncation as the failure mode. Measure this agent's own
 * distribution before capping it.
 */
const makePageBuilderSet = (
  model: ResolvedModel,
): AgentSet<ChatbotCallOptions, PageBuilderTools> =>
  buildAgentSet<ChatbotCallOptions, PageBuilderTools>({
    id: PAGE_BUILDER_AGENT_ID,
    // One build is one lane. Sharing the conversation's would hold its pin for
    // the whole 25-minute deadline, and hand the parent whichever host a
    // mid-build re-route landed on.
    sessionScope: "delegate",
    buildTools: buildPageBuilderTools,
    systemPrompt: pageBuilderSystemPrompt,
    // The builder writes whole SFCs through `pageWrite`, so its output cap is
    // also its file-size cap. 32 000 tokens ≈ a 1 200-line component, which is
    // above anything the review budget lets through in one step.
    maxOutputTokens: AGENT_STEP_MAX_OUTPUT_TOKENS,
    model,
    // Its OWN fallback role, under the page-build envelope. `chat-fallback`
    // served here until 2026-09-14 — resolved under the chat envelope, so a
    // fallback build ran without the role's reasoning allowance.
    fallbackModel: resolveModel("page-build-fallback"),
    stopWhen: [isStepCount(parsePageBuilderMaxSteps())],
    repairToolCall: llmRepairToolCall<PageBuilderTools>(),
    // 75% of `buildPage`'s 25-minute dispatch deadline. Past this the hard
    // cut is close enough that starting anything — a fix round, a review —
    // loses the whole run's tail; landing what exists beats polishing it.
    softDeadline: {
      afterMs: 1_125_000,
      text: "[deadline] The build is nearly out of time and will be cut off shortly. Land it NOW: make sure the page is saved, then stop — no more edits, no more reviews. Hand back the url with an honest one-line status of what was and was not verified.",
    },
    prepareStep: pageBuilderPrepareStep,
    buildRuntimeContextBase: buildChatbotRuntimeContextBase,
    callOptionsSchema: ChatbotCallOptionsSchema,
  });

const memoPageBuilderSet = memoizeAgentSets(makePageBuilderSet);

/**
 * The page builder for a given registry profile.
 *
 * THIS FUNCTION IS THE FIX for the defect found on 2026-08-18: the builder used
 * to be a module-level const built from `resolveModel("chat")`, and
 * `buildPageTool` closed over it. Because that const was evaluated once at
 * import, every memoized parent set — including the ones `getChatbotAgentSet`
 * builds per profile — shared the SAME builder on the SAME model. A team that
 * picked a flagship in Settings got it for the conversation and the code
 * default for every page that conversation produced.
 *
 * Resolution happens per call now, so the profile can come from the turn.
 * An override resolves through the PAGE-BUILD envelope, same as the default:
 * the role carries its own reasoning allowance (`settingsKind: "page-build"`,
 * `resolve.ts`), and a candidate resolved through the chat envelope would A/B
 * two envelopes instead of two models.
 */
export const getPageBuilderSet = (
  profileKey?: string,
): AgentSet<ChatbotCallOptions, PageBuilderTools> =>
  memoPageBuilderSet(
    profileKey === undefined
      ? resolveModel("page-build")
      : resolvePageBuildModelForProfile(profileKey),
  );

/**
 * `buildPage` tool — the page builder's only entry point. Deliberately NOT a
 * mode of `dispatchAgent`: different contract, different cost profile, and it
 * belongs next to `managePage` in the domain registry where a page request is
 * actually thought about (`tools/build-page.ts` carries the full rationale).
 */
export const buildPageTool = createBuildPageTool({
  // A RESOLVER, not an agent: the model is chosen when the tool runs, from the
  // turn's own options. Passing `pageBuilderSet.primary` here is what pinned
  // every page in the product to one profile for months.
  resolvePageBuilder: (profileKey) => getPageBuilderSet(profileKey).primary,
  // Same set, same number — the ceiling its own stop condition uses. The page builder is
  // the biggest single exposure: up to 80 steps behind one tool call.
  resolvePageBuilderCeiling: (profileKey) =>
    getPageBuilderSet(profileKey).contextCeiling,
  // The set has carried a fallback model all along; nothing reached for it. A
  // build that comes back having written nothing now gets the one retry the
  // parent turn has had since C4.
  resolvePageBuilderFallback: (profileKey) =>
    getPageBuilderSet(profileKey).fallback,
  // The rescue build for a run cut between writing its files and building them.
  salvagePage: salvagePageProject,
});

/**
 * The chatbot agent pair. Instantiated once at module init; reused
 * across every request. Handlers call
 * `chatbotAgentSet.primary.stream({ messages, options, abortSignal })`
 * with a try/catch falling back to `chatbotAgentSet.fallback.stream(...)`.
 */
const makeChatbotAgentSet = (
  model: ResolvedModel,
): AgentSet<ChatbotCallOptions, ChatbotTools> =>
  buildAgentSet<ChatbotCallOptions, ChatbotTools>({
    id: "chatbot",
    sessionScope: "conversation",
    buildTools: () =>
      buildChatbotTools({
        dispatchAgent: dispatchAgentTool,
        buildPage: buildPageTool,
      }),
    systemPrompt: chatbotSystemPrompt,
    maxOutputTokens: AGENT_STEP_MAX_OUTPUT_TOKENS,
    model,
    fallbackModel: resolveModel("chat-fallback"),
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
      isStepCount(parseChatbotMaxSteps()),
      hasToolCall("askUserQuestion"),
      // Pause the loop when a tool call is waiting for the user's approval in
      // the UI (a `run_plan` plan or a gated `records.bulk_*` write). The next
      // user message (sent by the frontend after grant/modify/reject) starts a
      // fresh turn — the agent re-runs the same code and the dispatch path
      // matches the grant by `lookupHash`.
      stopOnPendingApproval<ChatbotTools>(),
    ],
    repairToolCall: llmRepairToolCall<ChatbotTools>(),
    prepareStep: chatbotPrepareStep,
    buildRuntimeContextBase: buildChatbotRuntimeContextBase,
    callOptionsSchema: ChatbotCallOptionsSchema,
  });

/**
 * Chatbot agent set for an arbitrary registry profile — the seam the
 * C3 eval header (`X-Model-Profile-Key`) and the C8 per-team /
 * per-conversation selection call. No `profileKey` → the default
 * `chat` role binding. The fallback agent stays on the shared
 * `chat-fallback` binding regardless of the primary profile. Memoized
 * per profile (`memoizeAgentSets`) — mirrors `getWorkflowAgentSet`.
 */
const memoChatbotAgentSet = memoizeAgentSets(makeChatbotAgentSet);

export const getChatbotAgentSet = (
  profileKey?: string,
): AgentSet<ChatbotCallOptions, ChatbotTools> =>
  memoChatbotAgentSet(
    profileKey === undefined
      ? resolveModel("chat")
      : resolveChatModelForProfile(profileKey),
  );

/**
 * The default set. A FUNCTION rather than an exported instance, because an
 * instance is built at import — before `warmModelRegistry()` has run and before
 * any overnight quarantine can be read. `memoizeAgentSets` makes the repeat call
 * a map lookup, so nothing is rebuilt per turn.
 */
export const defaultChatbotAgentSet = (): AgentSet<
  ChatbotCallOptions,
  ChatbotTools
> => getChatbotAgentSet();
