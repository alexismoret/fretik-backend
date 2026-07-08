import type { EventActor } from "@fretik/shared/services/domain-events/emit";
import type { ModelProfile } from "../../lib/model-registry/types";
import type { DynamicToolManager } from "./dynamic-tools";
import type { TaskManager } from "./task-manager";

/**
 * @warning MUTATION CONTRACT — READ BEFORE ADDING A NEW TOOL
 *
 * AI SDK v6 documents `experimental_context` as immutable inside
 * tools ("Mutating the context object can lead to race conditions
 * and unexpected results when tools are called in parallel" —
 * `@ai-sdk/provider-utils` `ToolExecutionOptions` docblock).
 *
 * Fretik INTENTIONALLY deviates from this: `searchTools.execute`
 * mutates `ctx.dynamicToolManager` and `manageTasks.execute` mutates
 * `ctx.taskManager`. This is only safe because both mutations are
 * idempotent and commutative under the parallel-tool-calls that the
 * SDK can fire inside a single step:
 *
 *  - `DynamicToolManager.activate(names)` adds to a `Set<string>`.
 *    Re-adding the same name is a no-op. Two parallel activations
 *    with overlapping name sets end in the same final state.
 *
 *  - `TaskManager.setTasks(tasks)` is full-replacement semantics.
 *    Two parallel `setTasks` calls end in the state of whichever
 *    one executed last — identical to a single call with that list,
 *    so no unobservable intermediate state is produced.
 *
 * Any NEW tool that mutates the runtime context MUST preserve this
 * invariant. If you need a non-idempotent mutation (counter,
 * accumulator, ordered log, stateful reducer), either:
 *   (a) route the mutation through `DynamicToolManager` / `TaskManager`
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
 * Per-request runtime context propagated through every tool call via
 * AI SDK v6's `experimental_context` channel.
 *
 * The agent is a singleton constructed at boot; tools cannot close
 * over per-request state. `prepareCall` instantiates a fresh context
 * on every `.stream()` call and hands it to the framework as
 * `experimental_context`; tools recover it inside their `execute`
 * function via `getRuntimeContext`.
 *
 * `dynamicToolManager` and `taskManager` are required (not optional):
 * `prepareCall` instantiates them unconditionally so tools never have
 * to defend against missing fields.
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
   * `prompt.toJSON()` of the managed Langfuse prompt that produced this
   * turn's instructions, or `undefined` when the prompt resolved from the
   * embedded `.md` fallback (or Langfuse is off). Set once by the system-
   * prompt renderer inside `prepareCall` — before the agent loop, so never
   * races a tool call — and read back by the builder to link the generation
   * to its prompt version via `experimental_telemetry.metadata.langfusePrompt`.
   */
  langfusePromptLink?: string;
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
   * Per-request task checklist. Mutated by `manageTasks.execute()`;
   * discarded when the turn ends — no cross-request leakage because
   * each request gets a fresh instance from `prepareCall`.
   */
  taskManager: TaskManager;
  /**
   * Rendered `{{attachedFilesBlock}}` fragment for the system
   * prompt. Computed by the handler from the last user message's
   * `file` parts joined against `ai_chat_files`. Empty string when
   * no files are attached — the prompt section then renders as
   * `_No attached files._`.
   */
  attachedFilesBlock?: string;
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
   * headless workflow agent. The `updateWorkflowTask` / `completeWorkflowRun`
   * tools key their writes on it; absent for the chatbot (those tools aren't
   * in its set).
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
 * `prepareCall` passes the result to `experimental_context`; the
 * framework forwards it opaquely to every tool `execute`, and the
 * brand lets `getRuntimeContext` validate + narrow at runtime.
 */
export const wrapRuntimeContext = (
  ctx: AgentRuntimeContext,
): BrandedRuntimeContext => ({
  ...ctx,
  [RUNTIME_CONTEXT_BRAND]: true,
});

/**
 * Recover the runtime context from a tool `execute` options bag (or
 * from a `prepareStep` argument, which exposes the same
 * `experimental_context` key). Throws if the brand is missing — that
 * can only happen if somebody skipped `wrapRuntimeContext` inside
 * `prepareCall`, which is a programming bug and must fail loudly.
 *
 * Tools MUST read the context at call time via this helper. They
 * MUST NOT close over `ctx` at construction time — the agent is a
 * singleton and any captured reference would be shared across every
 * concurrent request.
 */
export const getRuntimeContext = (options: {
  experimental_context?: unknown;
}): AgentRuntimeContext => {
  const raw = options.experimental_context;
  if (
    raw === null ||
    typeof raw !== "object" ||
    !(RUNTIME_CONTEXT_BRAND in raw)
  ) {
    throw new Error(
      "Missing AgentRuntimeContext in experimental_context — prepareCall must wrap the ctx with wrapRuntimeContext() before returning it.",
    );
  }
  // Single `as` cast in the whole runtime-context module. The brand
  // symbol check above is the guard that makes this safe: only
  // objects produced by `wrapRuntimeContext` can ever reach this
  // line. Call sites never perform casts of their own.
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
