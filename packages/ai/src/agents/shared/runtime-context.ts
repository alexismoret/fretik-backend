import type { ToolPolicyLevel } from "@fretik/shared/schemas/tool-policies";
import type { EventActor } from "@fretik/shared/services/domain-events/emit";
import type { LangfusePromptRef } from "../../lib/langfuse-prompts";
import type { ModelProfile } from "../../lib/model-registry/types";
import type { NativeIngestionPlan } from "../../services/native-input/prepare-model-messages";
import type { DynamicToolManager } from "./dynamic-tools";

/**
 * @warning MUTATION CONTRACT — READ BEFORE ADDING A NEW TOOL
 *
 * AI SDK v7 documents a tool's `context` as immutable inside tools
 * ("Treat the context object as immutable inside tools. Mutating the
 * context object can lead to race conditions … If you need to mutate
 * the context, analyze the tool calls in `prepareStep` and update it
 * there." — `@ai-sdk/provider-utils` `ToolExecutionOptions` docblock).
 *
 * Fretik INTENTIONALLY deviates from this: `searchTools.execute`
 * mutates `ctx.dynamicToolManager`. This is only safe because the
 * mutation is idempotent and commutative under the parallel-tool-calls
 * that the SDK can fire inside a single step:
 *
 *  - `DynamicToolManager.activate(names)` adds to a `Set<string>`.
 *    Re-adding the same name is a no-op. Two parallel activations
 *    with overlapping name sets end in the same final state.
 *
 * Any NEW tool that mutates the runtime context MUST preserve this
 * invariant. If you need a non-idempotent mutation (counter,
 * accumulator, ordered log, stateful reducer), either:
 *   (a) route the mutation through `DynamicToolManager`,
 *       which already has the idempotence guarantee baked in,
 *   (b) or wrap the mutation in an async mutex keyed on the
 *       conversation id before writing,
 *   (c) or store the state OUTSIDE the runtime context (e.g. in a
 *       Redis key namespaced on the conversation id), which lets
 *       the concurrency layer handle serialization for you.
 *
 * Do NOT just attach a new mutable field to `AgentRuntimeContext`
 * and mutate it directly — the next parallel-tool-call turn will
 * produce a hard-to-reproduce race.
 */

/**
 * Per-request runtime context propagated to every tool call. AI SDK v7
 * delivers a tool's context ONLY through `toolsContext[toolName]`, so
 * `prepareCall` returns this branded ctx as the agent's `runtimeContext`
 * and each `prepareStep` fans it out to every tool via `toolsContext`.
 *
 * The agent is a singleton constructed at boot; tools cannot close
 * over per-request state. `prepareCall` instantiates a fresh context
 * on every `.stream()` call; tools recover it inside their `execute`
 * function via `getRuntimeContext(options)` (which reads `options.context`).
 *
 * `dynamicToolManager` is required (not optional): `prepareCall`
 * instantiates it unconditionally so tools never have to defend
 * against a missing field.
 */
export interface AgentRuntimeContext {
  organizationId: string;
  teamId: string;
  userId?: string;
  userName?: string;
  /**
   * Journal identity of the agent driving this turn (`domain_events.agent_key`).
   * Unset today — `agentEventActor` falls back to `"chatbot"`, the only agent.
   * A future runner reusing these tools (workflow engine) sets its own key
   * (`workflow:<key>`) when building its context; tools pick it up untouched.
   */
  agentKey?: string;
  /**
   * Profile of the model serving THIS agent instance (primary or
   * fallback), injected by `buildToolLoopAgent`'s `prepareCall` —
   * callers never provide it. Tools and the prompt renderer read it
   * for capability-aware decisions (native modalities, strict
   * schemas, reasoning style) instead of assuming a fixed model.
   */
  modelProfile: ModelProfile;
  /**
   * ID of the `ai_conversations` row this turn belongs to. Used by
   * the persisted-output layer to namespace large tool result files
   * and by the Python sandbox to scope its working directory.
   */
  conversationId?: string;
  /**
   * Per-turn trace identifier. Generated once per `runChatbotTurn`
   * (typically the resumable `streamId` when present, otherwise a
   * fresh UUIDv7) and prefixed onto every step / fallback / tool log
   * line so a single user turn can be reconstructed end-to-end from
   * the container logs without correlating timestamps. Optional only
   * for the legacy callers that don't yet thread it through; new code
   * should always populate it.
   */
  traceId?: string;
  /**
   * `{ name, version }` of the managed Langfuse prompt that produced this
   * turn's instructions, or `undefined` when the prompt resolved from the
   * embedded `.md` fallback (or Langfuse is off). Set once by the system-
   * prompt renderer inside `prepareCall` — before the agent loop, so never
   * races a tool call. The `@langfuse/vercel-ai-sdk` integration reads this
   * `langfusePrompt` runtime-context key (opted in via the agent's
   * `telemetry.includeRuntimeContext`) to link the generation to its version.
   * The key MUST be named `langfusePrompt` — that is what the integration
   * destructures.
   */
  langfusePrompt?: LangfusePromptRef;
  /**
   * IANA time-zone identifier of the requesting client (e.g.
   * `Europe/Paris`). Forwarded from `X-Client-Timezone` on the
   * user-facing route and `X-Context-Timezone` on the internal route.
   * Falls back to UTC inside the prompt renderer when missing or
   * invalid.
   */
  timeZone?: string;
  /**
   * Per-request state manager for Progressive Disclosure. Mutated by
   * `searchTools.execute()` when the model activates a domain tool;
   * read by the chatbot `prepareStep` hook on the next step to
   * rebuild the `activeTools` allow-list.
   */
  dynamicToolManager: DynamicToolManager;
  /**
   * Rendered `{{attachedFilesBlock}}` fragment for the system
   * prompt. Computed by the handler from the last user message's
   * `file` parts joined against `ai_chat_files`. Empty string when
   * no files are attached — the prompt section then renders as
   * `_No attached files._`.
   */
  attachedFilesBlock?: string;
  /**
   * Which attached files ride natively on THIS request and which the model
   * must open with a tool — from `planNativeIngestion`, the same plan
   * `prepareModelMessages` applies. Renders `{{nativeMediaNote}}`. Absent on
   * paths that build no messages; the note is then empty.
   */
  nativeIngestion?: NativeIngestionPlan;
  /**
   * Rendered `{{chatbotContextManifest}}` fragment for the system
   * prompt — a compact catalogue of the user / team persistent
   * context files (instructions + per-file metadata + outline +
   * preview, with small files inlined). Computed by the handler
   * through `buildChatbotContextManifest` against the
   * `ai_context_*` tables, with per-user mutes applied. The model
   * fetches file bodies via the regular `read` tool, which serves
   * `context/` Bun-side (no sandbox); the `python` / `bash` tools
   * additionally hydrate the files into `/workspace/context/...` on
   * demand via `prepareSandboxForCode`. Empty when neither
   * profile has any content
   * — the prompt section then renders as "_No persistent context
   * configured._".
   */
  chatbotContextManifest?: string;
  /**
   * Rendered `{{activeMemoryBlock}}` fragment for the system prompt —
   * a 1-3 bullet markdown summary of the persistent memories already
   * judged relevant for the current turn. Built by the handler before
   * the main `streamText` call via `runUnifiedRecall`
   * (`services/recall/recall.ts`). When `undefined` the prompt
   * omits the `<active_memory>` block entirely (which is itself a
   * signal — see `<memory_protocol>`). NEVER blocks the turn: a
   * recall failure or "NONE" verdict simply leaves this undefined.
   */
  activeMemoryBlock?: string;
  /**
   * Rendered `{{availableCapabilities}}` fragment — one workflow card when an
   * existing workflow already produces what this turn asks for. Built by the
   * same `runUnifiedRecall` call as `activeMemoryBlock`, but on a separate,
   * judge-free channel: a capability answers "does this already exist", not
   * "what is true", and the two compete destructively in one budget. Undefined
   * on the vast majority of turns — the gate requires the card to top the whole
   * retrieval ranking.
   */
  availableCapabilitiesBlock?: string;
  /**
   * Rendered `{{teamObjects}}` fragment for the system prompt — one line
   * per object type the team can query (`- **key** (view …) — columns: ….
   * relations: …`). The AI query path's schema-discovery block: it names
   * each type's typed SQL view + columns + outgoing relations. Full field
   * metadata is fetched on demand via `describeObjectType`. Built by the
   * handler from `describeTeamSchema`. Empty string when the team has no
   * types — the prompt section then renders as
   * `_No object types configured for this team._`.
   */
  teamObjectsBlock?: string;
  /**
   * Rendered `{{skillsCatalog}}` fragment for the system prompt — one
   * line per skill enabled for this team (`- **name** — description`),
   * ordered by name. Built by the handler from
   * `listEnabledSkillsForTeam` so always-on skills + the team's
   * configurable opt-ins are the ONLY ones the model ever sees.
   *
   * Filtering happens here (upstream) on purpose: a skill the team has
   * disabled never appears in the catalogue, the agent can't refer to
   * it, and the prompt avoids the negative-instruction tax forever
   * (Anthropic's recommended pattern — cf. plan §"Filtrage en amont").
   *
   * Empty / undefined renders as `_No skills enabled for this team._`.
   */
  enabledSkillsBlock?: string;
  /**
   * Roster of conversation participants (`- Name` per line), present only
   * for collaborative conversations (≥2 members). Renders the
   * `{{collaborationBlock}}` section; absent for solo conversations so the
   * prompt stays byte-identical to the single-user case.
   */
  participantsBlock?: string;
  /**
   * Active external-app connections (Outlook, Gmail, …) visible to this
   * turn — team-scoped rows + the caller's user-scoped rows, filtered
   * to `status = 'active'`. The handler loads them via
   * `listConnections(teamId, userId)` and re-uses them for two things:
   *
   *  1. Conditionally pushing `sandbox-assets/skills/<providerKey>/`
   *     into `/workspace/skills/<providerKey>/` at sandbox bootstrap —
   *     a SKILL.md the agent cannot actually use never bloats the
   *     filesystem.
   *  2. Rendering `{{externalAppsBlock}}` in the system prompt below.
   *
   * Empty array when the team has no external apps — the prompt block
   * then renders the "_No external apps connected._" placeholder.
   */
  externalAppConnections?: ExternalAppConnectionLite[];
  /**
   * Rendered `{{externalAppsBlock}}` fragment for the system prompt —
   * one line per active external-app connection (`- <providerKey>
   * (id: <uuid>, <displayName>)`). The id is included so the agent can
   * pass `connection_id=<id>` when the team has several connections for
   * the same provider (e.g. "Pro mailbox" + "Personal mailbox") to
   * disambiguate without prompting the user.
   *
   * Empty / undefined renders as `_No external apps connected._`.
   */
  externalAppsBlock?: string;
  /**
   * ID of the `workflow_runs` row this turn belongs to — set ONLY for the
   * headless workflow agent. The `completeTask` tool keys its writes on it;
   * absent for the chatbot (that tool isn't in its set).
   */
  workflowRunId?: string;
  /**
   * Autonomy of the running workflow. Gates the write path: `read_only`
   * rejects write plans, `approval_required` pauses on `run_plan` for HITL,
   * `autonomous` executes without pausing. Undefined for the chatbot.
   */
  workflowAutonomy?: "read_only" | "approval_required" | "autonomous";
  /**
   * Rendered `{{playbookBlock}}` fragment for the workflow system prompt —
   * the structured plan (goal + ordered tasks with per-task instructions +
   * the trigger payload) the executor follows. The reliability lever.
   * Undefined for the chatbot (which has no playbook).
   */
  playbookBlock?: string;
  /**
   * The team's builtin-tool permission overrides (`{ [toolName]: level }`),
   * loaded per turn by the handler (`getTeamToolPolicies`, Redis-cached). Read
   * by the policy gate (`policy-tool-gate.ts`) to prune `blocked` tools from
   * `activeTools` + the prompt, and by each gated write tool's `execute` to
   * route an `approval`-level call through the approval gate. Immutable for the
   * turn — no mutation-contract concern. Empty/undefined = every tool at its
   * catalog default.
   */
  toolPolicies?: Record<string, ToolPolicyLevel>;
  /**
   * Registry profile the page BUILDER should run on for this turn, when
   * something asked for one explicitly (the eval header). Undefined — the
   * normal case — means the `page-build` role binding decides.
   *
   * It exists because until 2026-08-18 there was no way to point the builder
   * anywhere: `X-Model-Profile-Key` repointed the parent turn only, so a
   * candidate run measured the model that DECIDES to build a page while the
   * one that writes it stayed on the code default.
   */
  pageBuildProfileKey?: string;
  /**
   * Thinking depth the turn resolved, carried so a delegate can be steered to
   * the same depth. The parent applies its own level to its wire call; without
   * this a sub-agent silently ran at its profile's default instead.
   */
  reasoningLevel?: string;
}

/**
 * Minimal view of an external-app connection that we ship into the
 * runtime context. Mirrors the public DTO (no Nango-internal fields)
 * but with `userId` already collapsed into the `scope` discriminator.
 */
export interface ExternalAppConnectionLite {
  id: string;
  providerKey: string;
  displayName: string;
  scope: "team" | "user";
  /**
   * Provider categories pulled from the manifest at request time. First
   * slug is the root (`communication`, `crm`, …); subsequent slugs are
   * fine-grained (`email`, `instant-messaging`, `calendar`, …). Used by
   * the agent to decide whether two connections are substitutable for a
   * given user intent.
   */
  categories: string[];
  /**
   * Per-connection runtime options keyed by the provider's descriptor
   * (e.g. `persona: "personal" | "bot"` for communication providers).
   * Only fields opted in with `exposeToAgent: true` are surfaced in the
   * system prompt; this map carries every persisted option so other
   * call sites (UI, audit) can read them too.
   */
  options: Record<string, unknown> | null;
}

/**
 * Brand symbol used to tag a wrapped context so `getRuntimeContext`
 * can narrow `unknown` → `AgentRuntimeContext` without exposing an
 * `as` cast at any call site. The single cast in this module is the
 * brand guard itself — documented in `getRuntimeContext` below.
 */
const RUNTIME_CONTEXT_BRAND: unique symbol = Symbol(
  "fretik.agent.runtime-context",
);

interface BrandedRuntimeContext extends AgentRuntimeContext {
  readonly [RUNTIME_CONTEXT_BRAND]: true;
}

/**
 * Wrap an `AgentRuntimeContext` so it carries the brand symbol.
 * `prepareCall` returns the result as the agent's `runtimeContext`;
 * `prepareStep` then fans that same reference out to every tool via
 * `toolsContext` (AI SDK v7 delivers a tool's context ONLY through
 * `toolsContext[toolName]` — there is no `runtimeContext` on the tool
 * `execute` options). The brand lets `getRuntimeContext` validate +
 * narrow the erased (`{}`/`unknown`) context back at runtime.
 */
export const wrapRuntimeContext = (
  ctx: AgentRuntimeContext,
): BrandedRuntimeContext => ({
  ...ctx,
  [RUNTIME_CONTEXT_BRAND]: true,
});

/**
 * Recover the runtime context from a tool `execute` options bag (reads
 * `options.context`) or from a `prepareStep` argument (reads
 * `options.runtimeContext`). Throws if the brand is missing — that can
 * only happen if `prepareCall` skipped `wrapRuntimeContext` or a
 * `prepareStep` failed to fan the ctx out via `toolsContext`, both
 * programming bugs that must fail loudly.
 *
 * Tools MUST read the context at call time via this helper. They
 * MUST NOT close over `ctx` at construction time — the agent is a
 * singleton and any captured reference would be shared across every
 * concurrent request.
 */
export const getRuntimeContext = (options: {
  context?: unknown;
  runtimeContext?: unknown;
}): AgentRuntimeContext => {
  const ctx = tryGetRuntimeContext(options);
  if (ctx === undefined) {
    throw new Error(
      "Missing AgentRuntimeContext — prepareCall must return the branded ctx as `runtimeContext`, and prepareStep must fan it out to every tool via `toolsContext`.",
    );
  }
  return ctx;
};

/**
 * Non-throwing variant of {@link getRuntimeContext} for read-only
 * observability seams (step loggers) that must degrade gracefully
 * rather than crash a callback when the brand is somehow absent.
 *
 * Reads `options.context` (tool `execute` channel — fed by
 * `toolsContext`) first, then `options.runtimeContext` (prepareStep /
 * step-callback channel). Returns `undefined` when neither carries a
 * branded context.
 */
export const tryGetRuntimeContext = (options: {
  context?: unknown;
  runtimeContext?: unknown;
}): AgentRuntimeContext | undefined => {
  const raw = options.context ?? options.runtimeContext;
  if (
    raw === null ||
    typeof raw !== "object" ||
    !(RUNTIME_CONTEXT_BRAND in raw)
  ) {
    return undefined;
  }
  // Single `as` cast in the whole runtime-context module. The brand
  // symbol check above is the guard that makes this safe: only
  // objects produced by `wrapRuntimeContext` can ever reach this
  // line. Call sites never perform casts of their own — the SDK
  // erases the per-tool context type to `{}`/`unknown` (no
  // `contextSchema`), so this brand narrowing is unavoidable.
  return raw as BrandedRuntimeContext;
};

/**
 * The journal `EventActor` for a write performed by THIS agent turn — the
 * single seam mapping runtime identity onto `domain_events` attribution.
 * Tools pass this to the shared mutation services instead of building their
 * own literal, so a future non-chatbot runner only has to set `ctx.agentKey`.
 */
export const agentEventActor = (ctx: AgentRuntimeContext): EventActor => ({
  actorType: "agent",
  actorUserId: ctx.userId ?? null,
  conversationId: ctx.conversationId ?? null,
  agentKey: ctx.agentKey ?? "chatbot",
});
