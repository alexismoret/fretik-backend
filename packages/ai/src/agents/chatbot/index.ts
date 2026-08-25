import { toolPolicyLevelSchema } from "@fretik/shared/schemas/tool-policies";
import { workflowAutonomySchema } from "@fretik/shared/schemas/workflows";
import { hasToolCall, isStepCount, type PrepareStepFunction } from "ai";
import { z } from "zod";
import {
  resolveChatModelForProfile,
  resolveModel,
  resolvePageBuildModelForProfile,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import { areWebToolsAvailable, WEB_TOOL_NAMES } from "../../lib/web-egress";
import { createBuildPageTool } from "../../tools/build-page";
import { createDispatchAgentTool } from "../../tools/dispatch-agent";
import {
  buildAgentSet,
  buildToolsContext,
  type AgentRuntimeContextBase,
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
import {
  buildPageBuilderSystemPrompt,
  buildSubAgentSystemPrompt,
} from "../shared/prompt-renderer";
import { llmRepairToolCall } from "../shared/repair-tool-call";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import { workflowSubAgentHiddenToolNames } from "../shared/workflow-tool-gate";
import { buildChatbotSystemPrompt } from "./system-prompt";
import {
  buildChatbotTools,
  buildPageBuilderTools,
  buildSubAgentTools,
  type ChatbotTools,
  type PageBuilderTools,
  type SubAgentTools,
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
 * The web tools are suppressed entirely when an operator sets
 * `AI_WEB_TOOLS_ENABLED=false` or no Tavily key is configured (both read by
 * `areWebToolsAvailable` in `lib/web-egress.ts`, which also owns the canonical
 * name list). Passing this as the `suppress` gate to the shared
 * Progressive-Disclosure helpers keeps them out of both `activeTools` and the
 * prompt's domain-tool catalogue, so the model never sees a tool it cannot use.
 */
const isToolSuppressed = (name: string): boolean =>
  !areWebToolsAvailable() && WEB_TOOL_NAMES.has(name);

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
   * Which of those files ride natively on THIS request and which the model
   * has to open with a tool — `planNativeIngestion`, the same plan
   * `prepareModelMessages` applies. Renders `{{nativeMediaNote}}`; without it
   * the note would state the profile's capability instead of the facts.
   */
  nativeIngestion: z
    .object({ native: z.array(z.string()), toolOnly: z.array(z.string()) })
    .optional(),
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
   * Active Memory recall block — a 1-3 bullet markdown summary of
   * memories already judged relevant for the current turn (see
   * `services/recall/recall.ts`). Threaded into
   * `AgentRuntimeContext.activeMemoryBlock` and substituted into the
   * `{{activeMemoryBlock}}` placeholder at the very bottom of the
   * dynamic suffix. Omitted when no candidate was relevant or when
   * recall failed / timed out (active memory must never block a turn).
   */
  activeMemoryBlock: z.string().optional(),
  /**
   * One workflow card when an existing workflow already produces what this
   * turn asks for — the capability channel of the same recall pass, kept out
   * of the judge's budget. Substituted into `{{availableCapabilities}}`.
   * Omitted on the vast majority of turns.
   */
  availableCapabilitiesBlock: z.string().optional(),
  /**
   * Catalogue of the team's collections for the AI query path — one line
   * per type (typed view + field columns + outgoing relations). The
   * handler builds it via `describeTeamSchema`. Threaded into
   * `AgentRuntimeContext.teamCollectionsBlock` and substituted into the
   * `{{teamCollections}}` placeholder under `<team_collections>` in the dynamic
   * suffix. Lets the LLM write correct typed-view + `links` queries
   * without an extra tool call. Omitted when the team has no types.
   */
  teamCollectionsBlock: z.string().optional(),
  /**
   * Catalogue of skills enabled for this team — one line per skill
   * (`- **name** — description`). The handler builds it via
   * `listEnabledSkillsForTeam` and threads it through
   * `AgentRuntimeContext.enabledSkillsBlock`, substituted into the
   * `{{skillsCatalog}}` placeholder. Filtering by team happens
   * upstream: disabled skills NEVER reach the prompt (Anthropic's
   * recommended pattern, vs. instructing the model negatively).
   * Empty / undefined renders as a placeholder line.
   */
  enabledSkillsBlock: z.string().optional(),
  /**
   * Roster of conversation participants — one line per member (`- Name`),
   * present ONLY when the conversation is collaborative (≥2 members). The
   * handler builds it via `buildSpeakerContext`; the same helper prefixes
   * every user message with `[Name]:` so the model knows who said what.
   * Omitted for solo conversations, which then render byte-identical to the
   * single-user prompt (no participants block, no labels).
   */
  participantsBlock: z.string().optional(),
  /**
   * Per-turn trace id. The handler generates this at the start of
   * `runChatbotTurn` (typically reusing the resumable `streamId`) and
   * threads it through so every step / fallback / tool log carries the
   * same identifier. Lets us reconstruct a single user turn from the
   * container logs without correlating timestamps.
   */
  traceId: z.string().optional(),
  /**
   * Active external-app connections (Outlook, …) visible to this turn.
   * Loaded by the handler via `listConnections(teamId, userId)` and
   * threaded into `AgentRuntimeContext.externalAppConnections`. The
   * sandbox bootstrap reads this list to push only the relevant SKILL.md
   * files into `/workspace/skills/<providerKey>/`.
   */
  externalAppConnections: z
    .array(
      z.object({
        id: z.string(),
        providerKey: z.string(),
        displayName: z.string(),
        scope: z.enum(["team", "user"]),
        categories: z.array(z.string()),
        options: z.record(z.string(), z.unknown()).nullable(),
      }),
    )
    .optional(),
  /**
   * Pre-rendered `{{externalAppsBlock}}` fragment for the system prompt
   * — one line per active connection. Omitted when the team has no
   * external apps; the prompt then shows the placeholder.
   */
  externalAppsBlock: z.string().optional(),
  /**
   * Autonomy of the enclosing workflow run, when this conversation belongs to
   * one. Poured into dispatched sub-agents (`dispatchAgent`) so they inherit
   * the run's write gate — same rules as the main workflow agent. Undefined for
   * plain chat (and its sub-agents), which then expose the full tool menu.
   */
  workflowAutonomy: workflowAutonomySchema.optional(),
  /**
   * The team's builtin-tool permission overrides (`{ [toolName]: level }`),
   * loaded per turn by the handler. Drives blocking (prune from the menu +
   * prompt) and per-tool approval routing. Omitted = every tool at its default.
   */
  toolPolicies: z.record(z.string(), toolPolicyLevelSchema).optional(),
  /**
   * Registry profile the PAGE BUILDER runs on for this turn — the seam an A/B
   * of page quality needs, and the one that did not exist until 2026-08-18.
   *
   * `X-Model-Profile-Key` only ever repointed the parent turn, so a candidate
   * run gated the model that DECIDES to build a page while the model that
   * actually writes it stayed on the code default. Omitted → the `page-build`
   * role binding, which is the answer on every real request.
   */
  pageBuildProfileKey: z.string().optional(),
  /**
   * Thinking depth for delegated work. The parent turn resolves its own level
   * through `effectiveReasoningLevel` and puts it on the wire itself; this
   * carries the same decision INTO a sub-agent, which previously received no
   * effort input at all — the page builder ran at its profile's default no
   * matter how deeply the user asked the turn to think.
   */
  reasoningLevel: z.string().optional(),
});

export type ChatbotCallOptions = z.infer<typeof ChatbotCallOptionsSchema>;

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
): Promise<string> => {
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
        policyHiddenToolNames(ctx),
      ),
      toolsContext: buildToolsContext(tools, ctx),
    };
  };
};

/**
 * Map `ChatbotCallOptions` → the pure-data subset of
 * `AgentRuntimeContext`. `buildAgentSet` injects the per-request
 * managers (`dynamicToolManager`, `taskManager`) on top.
 */
export const buildChatbotRuntimeContextBase = (
  options: ChatbotCallOptions,
): AgentRuntimeContextBase => ({
  organizationId: options.organizationId,
  teamId: options.teamId,
  userId: options.userId,
  userName: options.userName,
  conversationId: options.conversationId,
  timeZone: options.timeZone,
  attachedFilesBlock: options.attachedFilesBlock,
  nativeIngestion: options.nativeIngestion,
  chatbotContextManifest: options.chatbotContextManifest,
  activeMemoryBlock: options.activeMemoryBlock,
  availableCapabilitiesBlock: options.availableCapabilitiesBlock,
  teamCollectionsBlock: options.teamCollectionsBlock,
  enabledSkillsBlock: options.enabledSkillsBlock,
  participantsBlock: options.participantsBlock,
  externalAppConnections: options.externalAppConnections,
  externalAppsBlock: options.externalAppsBlock,
  traceId: options.traceId,
  // Carried so a workflow-dispatched sub-agent inherits the run's write gate;
  // undefined for plain chat.
  workflowAutonomy: options.workflowAutonomy,
  toolPolicies: options.toolPolicies,
  pageBuildProfileKey: options.pageBuildProfileKey,
  reasoningLevel: options.reasoningLevel,
});

/**
 * Sub-agent step budget. Default 25 — comfortable headroom for a
 * realistic "analyse 5 documents and compare" pattern (~5 reads +
 * ~5 python cells + a few RAG/SQL probes + final summary) while
 * staying tight enough that genuinely runaway sub-agents stop and
 * escalate to the parent. Tunable via `CHATBOT_SUB_AGENT_MAX_STEPS`
 * (range [1, 100]).
 *
 * When the budget IS exhausted, AI SDK does NOT throw — the run
 * stops gracefully with `finishReason !== "stop"` and `result.text`
 * is whatever the sub-agent had produced so far (often empty if the
 * last step was mid tool-call). The `dispatchAgent` execute below
 * detects this and prefixes the summary with a clear "[budget
 * exhausted]" marker so the parent agent can decide whether to
 * retry with a tighter task scope or accept the partial result.
 */
const parseSubAgentMaxSteps = (): number =>
  parseIntEnv("CHATBOT_SUB_AGENT_MAX_STEPS", {
    fallback: 25,
    min: 1,
    max: 100,
  });

/**
 * Sub-agent system prompt — pure static text, no per-turn variables.
 * The sub-agent receives every per-task signal (file paths, IDs,
 * acceptance criteria) verbatim through the `task` instruction the
 * parent passes via `dispatchAgent`. Wrapped in a callback to
 * satisfy `buildAgentSet`'s `systemPrompt` shape.
 */
const subAgentSystemPrompt = (ctx: AgentRuntimeContext): Promise<string> =>
  buildSubAgentSystemPrompt(ctx);

/**
 * Which tools a DELEGATE may not call. Team-policy blocked tools are hidden in
 * every context (chat + workflow); a delegate dispatched INSIDE a workflow run
 * additionally prunes the writes/memory the main workflow agent would, so
 * delegation cannot bypass the run's write gate.
 */
const delegateHiddenToolNames = (ctx: AgentRuntimeContext): Set<string> => {
  const hidden = new Set<string>(policyHiddenToolNames(ctx));
  if (ctx.workflowAutonomy !== undefined) {
    for (const name of workflowSubAgentHiddenToolNames(ctx.workflowAutonomy))
      hidden.add(name);
  }
  return hidden;
};

/**
 * Sub-agent tool gate. Every tool is active on every step — no Progressive
 * Disclosure inside a delegate run — minus whatever the gate above hides.
 *
 * `toolsContext` is LOAD-BEARING and was missing here until 2026-08-15: AI SDK
 * v7 hands a tool its context ONLY through `toolsContext[toolName]`, so without
 * it every tool a sub-agent called threw `Missing AgentRuntimeContext`. Nothing
 * about that failure was visible from outside: the throw came back as
 * INTERNAL_ERROR, the model read a run of them as an outage and returned a
 * fluent, entirely false "the platform is down" report instead of the work
 * (measured on the generalist sub-agent: 6 tool calls, 6 identical errors, one
 * apology). Written out per concrete tool set rather than once over a generic
 * `TTools`, because `InferToolSetContext<TTools>` only reduces to the
 * permissive `{}` at a concrete registry — see `buildToolsContext`.
 */
const subAgentPrepareStep = (
  tools: SubAgentTools,
): PrepareStepFunction<SubAgentTools> => {
  const allNames = Object.keys(tools) as (keyof SubAgentTools)[];
  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    const hidden = delegateHiddenToolNames(ctx);
    return {
      activeTools: allNames.filter((name) => !hidden.has(name)),
      toolsContext: buildToolsContext(tools, ctx),
    };
  };
};

/** The page builder's gate — same contract, its own concrete tool set. */
const pageBuilderPrepareStep = (
  tools: PageBuilderTools,
): PrepareStepFunction<PageBuilderTools> => {
  const allNames = Object.keys(tools) as (keyof PageBuilderTools)[];
  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    const hidden = delegateHiddenToolNames(ctx);
    return {
      activeTools: allNames.filter((name) => !hidden.has(name)),
      toolsContext: buildToolsContext(tools, ctx),
    };
  };
};

/**
 * Sub-agent set on the PRIMARY model — same model as the main agent
 * with the same fallback. Used when `dispatchAgent({ model: 'primary' })`
 * (the default) is called.
 *
 * `prepareStep` (`subAgentPrepareStep`) exposes every tool for a plain-chat
 * sub-agent (no Progressive Disclosure inside a sub-agent run) but applies the
 * workflow write gate when the sub-agent runs inside a workflow.
 */
const subAgentPrimarySet = buildAgentSet<ChatbotCallOptions, SubAgentTools>({
  id: "chatbot.sub.primary",
  buildTools: buildSubAgentTools,
  systemPrompt: subAgentSystemPrompt,
  model: resolveModel("chat"),
  fallbackModel: resolveModel("chat-fallback"),
  stopWhen: [
    isStepCount(parseSubAgentMaxSteps()),
    hasToolCall("askUserQuestion"),
  ],
  repairToolCall: llmRepairToolCall<SubAgentTools>(),
  prepareStep: subAgentPrepareStep,
  buildRuntimeContextBase: buildChatbotRuntimeContextBase,
  callOptionsSchema: ChatbotCallOptionsSchema,
});

/**
 * Sub-agent set on the CHEAP model (the registry's `dispatch-cheap` role,
 * `deepseek/deepseek-v4-flash-0731` by default). Used when
 * `dispatchAgent({ model: 'cheap' })` is called for well-scoped
 * mechanical sub-tasks (summarise one document, extract a known
 * schema, classify items).
 *
 * Fallback escalates to the main `chat` model: if the cheap model
 * errors out (rate-limit, provider 5xx, etc.), the parent's
 * `dispatchAgent` execute returns the primary model's result rather
 * than a hard failure.
 */
const subAgentCheapSet = buildAgentSet<ChatbotCallOptions, SubAgentTools>({
  id: "chatbot.sub.cheap",
  buildTools: buildSubAgentTools,
  systemPrompt: subAgentSystemPrompt,
  model: resolveModel("dispatch-cheap"),
  fallbackModel: resolveModel("chat"),
  stopWhen: [
    isStepCount(parseSubAgentMaxSteps()),
    hasToolCall("askUserQuestion"),
  ],
  repairToolCall: llmRepairToolCall<SubAgentTools>(),
  prepareStep: subAgentPrepareStep,
  buildRuntimeContextBase: buildChatbotRuntimeContextBase,
  callOptionsSchema: ChatbotCallOptionsSchema,
});

/**
 * Page-builder step budget. Higher than the generic sub-agent's 25 because a
 * build is a PIPELINE, not a task: probe, brief, component APIs (up to 6 per
 * call), the write, then up to three render-review-fix rounds of two calls
 * each. At 25 the loop would run out of budget precisely during the reviews —
 * the part that makes the page good. Tunable via `PAGE_BUILDER_MAX_STEPS`.
 */
const parsePageBuilderMaxSteps = (): number =>
  parseIntEnv("PAGE_BUILDER_MAX_STEPS", { fallback: 45, min: 1, max: 120 });

const pageBuilderSystemPrompt = (ctx: AgentRuntimeContext): Promise<string> =>
  buildPageBuilderSystemPrompt(ctx);

/**
 * Page-builder agent set — the third delegate, reached through the `buildPage`
 * tool and nothing else (`dispatchAgent` has no route to it). Since
 * 2026-08-21 that door is also the ONLY way a page gets authored at all: every
 * other agent's `managePage` is built with `pageAuthoring: false`.
 *
 * On the PRIMARY model, never the cheap one: it writes a whole Vue SFC and
 * then reads a design critique of it. Its tool registry is a short positive
 * list (`buildPageBuilderTools`), so no gating hook is needed — every tool it
 * has, it may call on every step. The team policy gate still applies, which is
 * why it shares `subAgentPrepareStep`: a team that disabled `managePage` must
 * not get pages through a delegate.
 */
const makePageBuilderSet = (
  model: ResolvedModel,
): AgentSet<ChatbotCallOptions, PageBuilderTools> =>
  buildAgentSet<ChatbotCallOptions, PageBuilderTools>({
    id: "chatbot.page-builder",
    buildTools: buildPageBuilderTools,
    systemPrompt: pageBuilderSystemPrompt,
    model,
    fallbackModel: resolveModel("chat-fallback"),
    stopWhen: [isStepCount(parsePageBuilderMaxSteps())],
    repairToolCall: llmRepairToolCall<PageBuilderTools>(),
    // 75% of `buildPage`'s 15-minute dispatch deadline. Past this the hard
    // cut is close enough that starting anything — a fix round, a review —
    // loses the whole run's tail; landing what exists beats polishing it.
    softDeadline: {
      afterMs: 675_000,
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
 * `dispatchAgent` tool — built once against the sub-agent sets above.
 * Routed by the `model` parameter passed by the parent agent at call
 * time: `"primary"` (default) → `subAgentPrimarySet`, `"cheap"` →
 * `subAgentCheapSet`. The tool itself is registered as a `core` tool
 * in `buildChatbotTools` so it's always available to the parent
 * without going through Progressive Disclosure.
 */
export const dispatchAgentTool = createDispatchAgentTool({
  primary: subAgentPrimarySet.primary,
  cheap: subAgentCheapSet.primary,
});

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
  // The set has carried a fallback model all along; nothing reached for it. A
  // build that comes back having written nothing now gets the one retry the
  // parent turn has had since C4.
  resolvePageBuilderFallback: (profileKey) =>
    getPageBuilderSet(profileKey).fallback,
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
    buildTools: () =>
      buildChatbotTools({
        dispatchAgent: dispatchAgentTool,
        buildPage: buildPageTool,
      }),
    systemPrompt: chatbotSystemPrompt,
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

export const chatbotAgentSet = getChatbotAgentSet();
