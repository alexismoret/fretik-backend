import {
  hasToolCall,
  stepCountIs,
  type PrepareStepFunction,
  type StopCondition,
} from "ai";
import { z } from "zod";
import {
  chatModel,
  dispatchAgentCheapModel,
  fallbackChatModel,
} from "../../lib/openrouter";
import { createDispatchAgentTool } from "../../tools/dispatch-agent";
import {
  buildAgentSet,
  type AgentRuntimeContextBase,
} from "../shared/agent-builder";
import type { SearchableToolRegistry } from "../shared/chatbot-tool";
import { buildSubAgentSystemPrompt } from "../shared/prompt-renderer";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import { buildChatbotSystemPrompt } from "./system-prompt";
import {
  buildChatbotTools,
  buildSubAgentTools,
  type ChatbotTools,
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
   * Active Memory recall block — a 1-3 bullet markdown summary of
   * memories already judged relevant for the current turn (see
   * `services/active-memory/recall.ts`). Threaded into
   * `AgentRuntimeContext.activeMemoryBlock` and substituted into the
   * `{{activeMemoryBlock}}` placeholder at the very bottom of the
   * dynamic suffix. Omitted when no candidate was relevant or when
   * recall failed / timed out (active memory must never block a turn).
   */
  activeMemoryBlock: z.string().optional(),
  /**
   * Compact catalogue of the team's enabled dynamic field definitions
   * — one line per field (`- key (type)`), ordered by `displayOrder`.
   * The handler builds it via `getFieldDefinitionsForTeam`
   * (Redis-cached). Threaded into
   * `AgentRuntimeContext.teamFieldDefinitionsBlock` and substituted
   * into the `{{teamFieldDefinitions}}` placeholder under
   * `<team_fields>` in the dynamic suffix. Lets the LLM write correct
   * `document_field_values.field_key` queries and
   * `customFilters[].fieldKey` for `listDocuments` without an extra
   * tool call. Omitted when the team has no enabled fields.
   */
  teamFieldDefinitionsBlock: z.string().optional(),
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
): Promise<string> => buildChatbotSystemPrompt(ctx, pickDomainRegistry(tools));

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
  activeMemoryBlock: options.activeMemoryBlock,
  teamFieldDefinitionsBlock: options.teamFieldDefinitionsBlock,
  enabledSkillsBlock: options.enabledSkillsBlock,
  externalAppConnections: options.externalAppConnections,
  externalAppsBlock: options.externalAppsBlock,
  traceId: options.traceId,
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
const parseSubAgentMaxSteps = (): number => {
  const raw = process.env.CHATBOT_SUB_AGENT_MAX_STEPS;
  if (raw === undefined || raw === "") return 25;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(
      `Invalid CHATBOT_SUB_AGENT_MAX_STEPS: "${raw}" — expected an integer in [1, 100].`,
    );
  }
  return parsed;
};

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
 * Sub-agent set on the PRIMARY model — same model as the main agent
 * with the same fallback. Used when `dispatchAgent({ model: 'primary' })`
 * (the default) is called.
 *
 * No `prepareStep` hook → the framework defaults to "every tool name
 * in the registry is active on every step", which is what we want
 * for a sub-agent (no Progressive Disclosure inside a sub-agent run).
 */
const subAgentPrimarySet = buildAgentSet<ChatbotCallOptions, SubAgentTools>({
  id: "chatbot.sub.primary",
  buildTools: buildSubAgentTools,
  systemPrompt: subAgentSystemPrompt,
  model: chatModel,
  fallbackModel: fallbackChatModel,
  stopWhen: [
    stepCountIs(parseSubAgentMaxSteps()),
    hasToolCall("askUserQuestion"),
  ],
  buildRuntimeContextBase: buildChatbotRuntimeContextBase,
  callOptionsSchema: ChatbotCallOptionsSchema,
});

/**
 * Sub-agent set on the CHEAP model (`dispatchAgentCheapModel`,
 * `deepseek/deepseek-v4-flash` by default). Used when
 * `dispatchAgent({ model: 'cheap' })` is called for well-scoped
 * mechanical sub-tasks (summarise one document, extract a known
 * schema, classify items).
 *
 * Fallback escalates to the main `chatModel`: if the cheap model
 * errors out (rate-limit, provider 5xx, etc.), the parent's
 * `dispatchAgent` execute returns the primary model's result rather
 * than a hard failure.
 */
const subAgentCheapSet = buildAgentSet<ChatbotCallOptions, SubAgentTools>({
  id: "chatbot.sub.cheap",
  buildTools: buildSubAgentTools,
  systemPrompt: subAgentSystemPrompt,
  model: dispatchAgentCheapModel,
  fallbackModel: chatModel,
  stopWhen: [
    stepCountIs(parseSubAgentMaxSteps()),
    hasToolCall("askUserQuestion"),
  ],
  buildRuntimeContextBase: buildChatbotRuntimeContextBase,
  callOptionsSchema: ChatbotCallOptionsSchema,
});

/**
 * `dispatchAgent` tool — built once against the sub-agent sets above.
 * Routed by the `model` parameter passed by the parent agent at call
 * time: `"primary"` (default) → `subAgentPrimarySet`, `"cheap"` →
 * `subAgentCheapSet`. The tool itself is registered as a `core` tool
 * in `buildChatbotTools` so it's always available to the parent
 * without going through Progressive Disclosure.
 */
const dispatchAgentTool = createDispatchAgentTool({
  primary: subAgentPrimarySet.primary,
  cheap: subAgentCheapSet.primary,
});

/**
 * Custom `stopWhen` predicate — halts the agent loop the moment a
 * `python` tool call comes back with `{ status: "approval_pending" }`.
 *
 * `hasToolCall("python")` would fire on every step that ran python, not
 * just the ones where execution paused waiting for a HITL approval, so
 * we walk the last step's `toolResults` and look at the output shape
 * instead. Symmetric to `hasToolCall("askUserQuestion")` (which is also
 * load-bearing): without it, the agent would loop python → ApprovalPending
 * → python forever, since each retry re-emits the same code, hits the
 * same dispatch path, and the approval row is still `pending`.
 *
 * Defining this in TypeScript with `unknown` narrowing (not `as`) keeps
 * the codebase's no-cast rule intact.
 */
const pythonAwaitingApproval: StopCondition<ChatbotTools> = ({ steps }) => {
  const lastStep = steps.at(-1);
  if (lastStep === undefined) return false;
  for (const tr of lastStep.toolResults) {
    if (tr.toolName !== "python") continue;
    const output: unknown = tr.output;
    if (output === null || typeof output !== "object") continue;
    if (!("status" in output)) continue;
    if (output.status === "approval_pending") return true;
  }
  return false;
};

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
  buildTools: () => buildChatbotTools({ dispatchAgent: dispatchAgentTool }),
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
    // Pause the loop when a write plan submitted via `run_plan(...)` is
    // waiting for the user's approval in the UI. The next user message
    // (sent by the frontend after grant/modify/reject) starts a fresh
    // turn — the agent re-runs the same code and the dispatch path
    // matches the grant by `lookupHash`.
    pythonAwaitingApproval,
  ],
  prepareStep: chatbotPrepareStep,
  buildRuntimeContextBase: buildChatbotRuntimeContextBase,
  callOptionsSchema: ChatbotCallOptionsSchema,
});
