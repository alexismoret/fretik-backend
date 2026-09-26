import { toolPolicyLevelSchema } from "@fretik/shared/schemas/tool-policies";
import { workflowAutonomySchema } from "@fretik/shared/schemas/workflows";
import { z } from "zod";
import type { AgentRuntimeContextBase } from "../shared/agent-builder";

/**
 * The call contract every agent built on the chatbot tool registry shares —
 * the chat turn, its sub-agents and the page builder. Its own module so the
 * sub-agent runtime (`./delegate.ts`) can build agents on it without importing
 * `./index.ts`, which imports the sub-agent runtime back.
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
   * Memory INDEX — the tree of `/memories/{user,team}/` paths and sizes, no
   * content. Always present (one indexed SELECT in the fragment batch), where
   * `activeMemoryBlock` only appears when the message matched something.
   * Substituted into `{{memoryIndex}}`.
   */
  memoryIndexBlock: z.string().optional(),
  /**
   * The team's standing memory — content, not paths, and not retrieved. Where
   * `activeMemoryBlock` only appears when the message matched something, this
   * is present on every turn, which is what a question naming nothing stands
   * on. Substituted into `{{standingMemory}}`.
   */
  standingMemoryBlock: z.string().optional(),
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
  /**
   * The team's `documents` pick (shown as "Fast"), resolved once per turn: the
   * model a `dispatchAgent({ model: "fast" })` runs on. Omitted → such a
   * dispatch stays on the parent's model.
   */
  fastProfileKey: z.string().optional(),
  /**
   * The conversation has had sub-agents — shows `manageAgents`. Read per turn
   * by the handler.
   */
  hasSubAgents: z.boolean().optional(),
  /**
   * Set only on a sub-agent's call, by `dispatchAgent`: the id of that run.
   * Gives the run a Python kernel of its own and marks its sandbox calls as a
   * sub-agent's, which `/sandbox/exec` refuses writes and approvals to.
   */
  delegateRunId: z.string().optional(),
});

export type ChatbotCallOptions = z.infer<typeof ChatbotCallOptionsSchema>;

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
  memoryIndexBlock: options.memoryIndexBlock,
  standingMemoryBlock: options.standingMemoryBlock,
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
  fastProfileKey: options.fastProfileKey,
  hasSubAgents: options.hasSubAgents,
  delegateRunId: options.delegateRunId,
});
