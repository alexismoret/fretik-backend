import { TOOL_PERMISSIONS_REMEDIATION } from "@fretik/shared/services/ai/remediation";
import { fetchManagedPrompt } from "../../lib/langfuse-prompts";
import type { NativeIngestionPlan } from "../../services/native-input/prepare-model-messages";
import { buildSessionStateBlock } from "../../services/session-state/build-block";
import type { SearchableToolRegistry } from "./chatbot-tool";
import { policyHiddenToolNames } from "./policy-tool-gate";
import { resolveAgentBlocks } from "./prompt-blocks";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * Dynamic-suffix note listing the tools the team disabled via tool-permission
 * settings — so the model can tell the user WHY it can't do something instead
 * of silently lacking the tool. Empty (byte-identical to today) when nothing is
 * blocked. Below the cache marker; the tools are already pruned from the menu.
 */
const buildBlockedToolsNote = (ctx: AgentRuntimeContext): string => {
  const blocked = [...policyHiddenToolNames(ctx)];
  if (blocked.length === 0) return "";
  return `These tools are disabled by the team's permission settings and cannot be called: ${blocked.join(", ")}. If the user asks for one: ${TOOL_PERMISSIONS_REMEDIATION}`;
};

/**
 * Dynamic-suffix note (C5) telling the model that attachments of the
 * modalities its profile sends native are directly visible — so it should
 * answer from what it sees rather than reach for `vision`. Empty for inert
 * / non-multimodal profiles, keeping the rendered prompt byte-identical to
 * today. Below the cache marker, so it never touches the static prefix.
 */
const buildNativeMediaNote = (
  plan: NativeIngestionPlan | undefined,
): string => {
  // NAMES, not capabilities. Stating what the profile *can* ingest made the
  // note false for every file past the recency cap, for every non-native mime,
  // and for 100% of workflow runs (no file part ever reaches a run's messages).
  // The model then treated the whole `<file_attachments>` list as visible and
  // never opened what it could have read.
  if (!plan || (plan.native.length === 0 && plan.toolOnly.length === 0)) {
    return "";
  }
  const lines: string[] = [];
  if (plan.native.length > 0) {
    lines.push(
      `**${formatList(plan.native)} ${plan.native.length > 1 ? "are" : "is"} directly visible to you in this message** — answer from what you see. Call \`vision\` only for a finer visual sub-question, and \`read\` when you need exact text to quote or line-precise navigation.`,
    );
  }
  if (plan.toolOnly.length > 0) {
    lines.push(
      `${formatList(plan.toolOnly)} ${plan.toolOnly.length > 1 ? "are" : "is"} attached to this conversation but NOT in this message — reach ${plan.toolOnly.length > 1 ? "them" : "it"} with the tool named on ${plan.toolOnly.length > 1 ? "their entries" : "its entry"} in \`<file_attachments>\`.`,
    );
  }
  return lines.join("\n");
};

const formatList = (names: string[]): string =>
  names.length > 2
    ? `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
    : names.join(" and ");

/**
 * Pure prompt template renderer used by the chatbot agent.
 *
 * The Markdown template lives at `agents/shared/agent-system-prompt.md` and
 * is loaded once at module init through `Bun.file()` + top-level await.
 * Renders are then synchronous `{{variable}}` substitutions against the
 * cached string. Keeping the renderer side-effect free makes it
 * trivially testable and lets the `systemPrompt` callback in
 * `agent-builder.ts` stay synchronous.
 *
 * Sections in the template are ordered static → dynamic so that the
 * stable prefix (everything above the DYNAMIC SUFFIX marker in the .md)
 * is byte-identical across turns. OpenRouter providers that support
 * implicit caching (OpenAI, DeepSeek, Gemini) then serve that prefix
 * from cache at 0.25-0.5× the input price; Anthropic models can opt
 * into the same via an explicit `cache_control` breakpoint at the
 * prefix/suffix boundary. The full architecture, rules, and reasoning
 * live in the header comment of `system-prompt.md` itself.
 *
 * HTML comments in the .md are stripped here so the maintainer
 * documentation doesn't cost model tokens at runtime.
 */

/**
 * ONE unified template serves the chatbot AND the workflow executor —
 * agent-specific paragraphs are wrapped in `<!-- AGENT:… -->` blocks and
 * resolved per agent by `resolveAgentBlocks` (see `prompt-blocks.ts`). Each
 * resolved variant is its own Langfuse prompt (and its own byte-stable
 * cached prefix); improving a shared section improves both agents.
 */
const UNIFIED_TEMPLATE_URL = new URL(
  "./agent-system-prompt.md",
  import.meta.url,
);
const SUB_AGENT_TEMPLATE_URL = new URL(
  "../chatbot/sub-agent-system-prompt.md",
  import.meta.url,
);

/**
 * Match `<!-- ... -->` blocks (including multi-line). The trailing
 * newline is consumed when the comment occupies its own line, so
 * stripping doesn't leave dangling blank lines.
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

/**
 * Names of the chatbot prompts managed in Langfuse Prompt Management, each
 * paired with the repo `.md` that seeds it and serves as the offline
 * fallback. Single source of truth shared with
 * `scripts/seed-langfuse-prompts.ts`.
 */
export const MANAGED_PROMPTS = {
  system: { name: "fretik-chatbot-system", url: UNIFIED_TEMPLATE_URL },
  workflow: { name: "fretik-workflow-system", url: UNIFIED_TEMPLATE_URL },
  subAgent: { name: "fretik-chatbot-sub-agent", url: SUB_AGENT_TEMPLATE_URL },
} as const;

/**
 * Per-agent fallbacks, resolved from the unified source ONCE at module load
 * (HTML comments still INTACT — stripped per turn after fetch, so the
 * DYNAMIC SUFFIX marker stays visible in the fallback text). The Langfuse
 * STORED prompts are published per agent, ALREADY resolved, by
 * `scripts/seed-langfuse-prompts.ts` — the runtime never resolves blocks on
 * the fetched text; this fallback path (Langfuse off / unreachable /
 * LANGFUSE_PROMPTS_LOCAL) is the only consumer of `resolveAgentBlocks` here.
 */
const UNIFIED_TEMPLATE_RAW = await Bun.file(UNIFIED_TEMPLATE_URL).text();
const SYSTEM_PROMPT_FALLBACK = resolveAgentBlocks(
  UNIFIED_TEMPLATE_RAW,
  "chatbot",
);
const WORKFLOW_PROMPT_FALLBACK = resolveAgentBlocks(
  UNIFIED_TEMPLATE_RAW,
  "workflow",
);
const SUB_AGENT_FALLBACK = await Bun.file(SUB_AGENT_TEMPLATE_URL).text();

/**
 * Sub-agent system prompt. Managed in Langfuse (label per environment),
 * falling back to the embedded `.md`. Pure static text (no `{{placeholder}}`
 * substitutions): the sub-agent receives per-task context verbatim through
 * the `task` instruction from the parent's `dispatchAgent` tool. Strips HTML
 * comments and records the prompt's trace-link on `ctx` so the sub-agent's
 * generations link to the version that produced them.
 */
export const buildSubAgentSystemPrompt = async (
  ctx: AgentRuntimeContext,
): Promise<string> => {
  const { text, promptRef } = await fetchManagedPrompt(
    MANAGED_PROMPTS.subAgent.name,
    SUB_AGENT_FALLBACK,
  );
  ctx.langfusePrompt = promptRef;
  return text.replace(HTML_COMMENT_RE, "").trim();
};

/**
 * Format a `Date` the same way the Claude reference prompt does but
 * with the current time and an explicit timezone suffix:
 * `Tuesday, February 17, 2026, 15:45 (Europe/Paris, GMT+2)`.
 *
 * Uses `en-US` locale explicitly so the output is stable regardless of
 * the server's locale settings, and forces 24h time (`hour12: false`)
 * so time-sensitive business data — where 15:00 vs 03:00 really
 * matters — is never ambiguous. The timezone is resolved from the client (Nuxt app sends
 * an `X-Client-Timezone` header, the internal middleware forwards
 * `X-Context-Timezone`) so the date shown in the prompt matches what
 * the user sees in their browser. Falls back to UTC when the header is
 * missing or invalid — a bad client header must never break a
 * conversation turn.
 */
const formatWithZone = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const offset = pick("timeZoneName"); // e.g. "GMT+2", "GMT-05:00"
  const date_ = `${pick("weekday")}, ${pick("month")} ${pick("day")}, ${pick("year")}`;
  const time = `${pick("hour")}:${pick("minute")}`;
  return `${date_}, ${time} (${timeZone}, ${offset})`;
};

export const formatCurrentDate = (
  date: Date,
  timeZone: string | undefined,
): string => {
  try {
    return formatWithZone(date, timeZone ?? "UTC");
  } catch {
    return formatWithZone(date, "UTC");
  }
};

/**
 * Replace every `{{key}}` occurrence in `template` with the matching
 * value from `variables`. Unknown placeholders are left untouched so a
 * missing variable shows up visibly in logs instead of being silently
 * stripped.
 *
 * **Injection hardening (Sprint B — plan §3.9).** Every value passed in
 * is sanitized to neutralize embedded template tokens before
 * substitution. If a variable's content itself contained `{{otherKey}}`
 * it would normally remain literal in the rendered output (good), but
 * if a *future* renderer pass were to run on the result the embedded
 * token could resolve into another value — opening a path for indirect
 * prompt injection from any user-derived field (memory entries,
 * attached file captions, persistent context blocks, …).
 *
 * We defuse this at the substitution boundary by inserting a zero-width
 * separator inside any `{{` or `}}` sequence in the value. The token is
 * still visible to a human reading the prompt (`{ {fakeKey} }`) but is
 * no longer matched by `replaceAll(\`{{${key}}}\`, …)` on a hypothetical
 * second pass. Pure defense in depth — every current value is server-
 * controlled (UUIDs, formatted date, DB-backed context blocks), so this
 * costs nothing today and eliminates a sharp edge for any future user-
 * derived variable (memory tool, custom instructions, …).
 */
const sanitizeVariableValue = (value: string): string =>
  value.replaceAll("{{", "{ {").replaceAll("}}", "} }");

export const renderPrompt = (
  template: string,
  variables: Record<string, string>,
): string => {
  return Object.entries(variables).reduce(
    (acc, [key, value]) =>
      acc.replaceAll(`{{${key}}}`, sanitizeVariableValue(value)),
    template,
  );
};

/**
 * Render the `{{deferredToolList}}` placeholder from the set of domain
 * tools that are listed in the prompt but not loaded into the initial
 * `streamText()` call. Each line is `- **name** — searchHint` so the
 * model can match a user intent to a tool name and activate it through
 * `searchTools`. Returns a placeholder when the registry is empty.
 */
const formatDeferredToolList = (
  deferredTools: SearchableToolRegistry,
): string => {
  const entries = Object.entries(deferredTools);
  if (entries.length === 0) {
    return "_No domain tools registered yet._";
  }
  return entries
    .map(([name, tool]) => `- **${name}** — ${tool.searchHint}`)
    .join("\n");
};

/**
 * Pre-rendered `{{skillsCatalog}}` block — the L1 listing of skills
 * the team has enabled. Built once per turn by the chatbot handler
 * (`listEnabledSkillsForTeam → formatEnabledSkillsBlock`) and passed
 * in via `ctx.enabledSkillsBlock`.
 *
 * The handler does the team filtering on purpose: a skill the team
 * has disabled NEVER reaches the prompt. The agent has no way to
 * know it exists and can't accidentally call into it (Anthropic's
 * recommended pattern over instructing the model negatively — see
 * plan §"Filtrage en amont"). When the team has no enabled skills
 * the renderer falls back to a placeholder line.
 */

/**
 * Per-family system-prompt overlays (`agents/chatbot/overlays/<key>.md`).
 * Loaded once per replica, keyed by `profile.assessment.promptOverlayKey`;
 * a missing file renders as the empty string so profiles without an
 * overlay produce a byte-identical prompt. Cache-safe by construction:
 * prompt caches are namespaced per upstream model, the overlay is
 * deterministic per profile, and it is spliced ABOVE the dynamic-suffix
 * marker so the static prefix stays byte-stable per model.
 *
 * Overlays start EMPTY for every family — write one only when a C3
 * eval failure demonstrates a family-specific need
 * (`.agent/agent-context-framework.md`: growth without sharpening is a
 * regression).
 */
const overlayCache = new Map<string, Promise<string>>();

const loadPromptOverlay = (key: string | undefined): Promise<string> => {
  if (!key) return Promise.resolve("");
  const cached = overlayCache.get(key);
  if (cached) return cached;
  const loading = (async () => {
    const file = Bun.file(
      new URL(`../chatbot/overlays/${key}.md`, import.meta.url),
    );
    if (!(await file.exists())) return "";
    return (await file.text()).trim();
  })();
  overlayCache.set(key, loading);
  return loading;
};

/**
 * Splice an overlay at the END of the static prefix — immediately above
 * the DYNAMIC SUFFIX marker comment, so per-turn placeholders stay
 * below it. Falls back to appending when the marker is absent (foreign
 * prompt text); a comment-only marker means the overlay survives the
 * per-turn comment strip while the marker itself does not. Exported
 * for tests.
 */
export const insertPromptOverlay = (text: string, overlay: string): string => {
  if (overlay.length === 0) return text;
  const suffixAt = text.indexOf("DYNAMIC SUFFIX — every");
  const markerAt = suffixAt === -1 ? -1 : text.lastIndexOf("<!--", suffixAt);
  if (markerAt === -1) return `${text}\n\n${overlay}\n`;
  return `${text.slice(0, markerAt)}${overlay}\n\n${text.slice(markerAt)}`;
};

/**
 * Build the chatbot system prompt for a given runtime context.
 *
 * `deferredTools` defaults to an empty set so callers can build the
 * prompt with no domain catalogue. The agent-builder always passes
 * the full domain-tool registry so `{{deferredToolList}}` reflects
 * what `searchTools` can activate.
 */
export const buildChatbotSystemPrompt = async (
  ctx: AgentRuntimeContext,
  deferredTools: SearchableToolRegistry = {},
): Promise<string> => {
  const { text, promptRef } = await fetchManagedPrompt(
    MANAGED_PROMPTS.system.name,
    SYSTEM_PROMPT_FALLBACK,
  );
  ctx.langfusePrompt = promptRef;
  const overlay = await loadPromptOverlay(
    ctx.modelProfile.assessment.promptOverlayKey,
  );
  // `.trim()` to match the seed script and the sub-agent path: the stored
  // (trimmed) text and the embedded fallback must be byte-identical so the
  // static prefix — and the OpenRouter prompt cache — survives every
  // Langfuse↔fallback transition.
  return renderPrompt(
    insertPromptOverlay(text, overlay).replace(HTML_COMMENT_RE, "").trim(),
    {
      currentDate: formatCurrentDate(new Date(), ctx.timeZone),
      userName: ctx.userName ?? "Unknown user",
      userId: ctx.userId ?? "unknown",
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      conversationId: ctx.conversationId ?? "unknown",
      deferredToolList: formatDeferredToolList(deferredTools),
      blockedToolsNote: buildBlockedToolsNote(ctx),
      skillsCatalog:
        ctx.enabledSkillsBlock && ctx.enabledSkillsBlock.length > 0
          ? ctx.enabledSkillsBlock
          : "_No skills enabled for this team._",
      attachedFilesBlock:
        ctx.attachedFilesBlock && ctx.attachedFilesBlock.length > 0
          ? ctx.attachedFilesBlock
          : "_No files attached to this conversation._",
      nativeMediaNote: buildNativeMediaNote(ctx.nativeIngestion),
      chatbotContextManifest:
        ctx.chatbotContextManifest && ctx.chatbotContextManifest.length > 0
          ? ctx.chatbotContextManifest
          : "_No persistent context configured._",
      sessionStateBlock: (() => {
        const block = buildSessionStateBlock({
          dynamicToolManager: ctx.dynamicToolManager,
        });
        return block.length > 0 ? block : "_No active session state._";
      })(),
      activeMemoryBlock:
        ctx.activeMemoryBlock && ctx.activeMemoryBlock.length > 0
          ? ctx.activeMemoryBlock
          : "_No relevant memory recalled for this turn._",
      teamObjects:
        ctx.teamObjectsBlock && ctx.teamObjectsBlock.length > 0
          ? ctx.teamObjectsBlock
          : "_No object types configured for this team._",
      externalAppsBlock:
        ctx.externalAppsBlock && ctx.externalAppsBlock.length > 0
          ? ctx.externalAppsBlock
          : "_No external apps connected._",
      // Collaborative-conversation block. Empty for solo conversations so the
      // prompt is byte-identical to the single-user case; populated (roster +
      // speaker-label instruction) once a second participant joins.
      collaborationBlock:
        ctx.participantsBlock && ctx.participantsBlock.length > 0
          ? `This conversation is shared by several teammates:\n${ctx.participantsBlock}\n\nEach user message is prefixed with its sender in brackets — \`[Name]: …\`. Address people by name when it helps, and suggest @mentioning a teammate when their input is needed.`
          : "",
    },
  );
};

/**
 * Build the workflow executor's system prompt — the `workflow` variant of
 * the unified template. Same render pipeline as the chatbot (managed prompt
 * → overlay → comment strip → variables); the variable map only covers the
 * placeholders present in the workflow variant (no userName / userId /
 * collaborationBlock — those live in chatbot-only blocks).
 */
export const buildWorkflowSystemPrompt = async (
  ctx: AgentRuntimeContext,
  deferredTools: SearchableToolRegistry = {},
): Promise<string> => {
  const { text, promptRef } = await fetchManagedPrompt(
    MANAGED_PROMPTS.workflow.name,
    WORKFLOW_PROMPT_FALLBACK,
  );
  ctx.langfusePrompt = promptRef;
  const overlay = await loadPromptOverlay(
    ctx.modelProfile.assessment.promptOverlayKey,
  );
  // The workflow variant is byte-stable per run: everything that mutates
  // between turns (current date, task statuses, turn-1 recall) rides in the
  // steering message, NOT here. So `currentDate`, `sessionStateBlock`, and
  // `activeMemoryBlock` are intentionally absent from this map — their
  // placeholders were removed from the `workflow` blocks of the template.
  return renderPrompt(
    insertPromptOverlay(text, overlay).replace(HTML_COMMENT_RE, "").trim(),
    {
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      conversationId: ctx.conversationId ?? "unknown",
      workflowRunId: ctx.workflowRunId ?? "unknown",
      playbookBlock:
        ctx.playbookBlock && ctx.playbookBlock.length > 0
          ? ctx.playbookBlock
          : "_No playbook provided — mark the current task failed._",
      deferredToolList: formatDeferredToolList(deferredTools),
      skillsCatalog:
        ctx.enabledSkillsBlock && ctx.enabledSkillsBlock.length > 0
          ? ctx.enabledSkillsBlock
          : "_No skills enabled for this team._",
      attachedFilesBlock:
        ctx.attachedFilesBlock && ctx.attachedFilesBlock.length > 0
          ? ctx.attachedFilesBlock
          : "_No files handed to this run._",
      nativeMediaNote: buildNativeMediaNote(ctx.nativeIngestion),
      blockedToolsNote: buildBlockedToolsNote(ctx),
      chatbotContextManifest:
        ctx.chatbotContextManifest && ctx.chatbotContextManifest.length > 0
          ? ctx.chatbotContextManifest
          : "_No persistent context configured._",
      teamObjects:
        ctx.teamObjectsBlock && ctx.teamObjectsBlock.length > 0
          ? ctx.teamObjectsBlock
          : "_No object types configured for this team._",
      externalAppsBlock:
        ctx.externalAppsBlock && ctx.externalAppsBlock.length > 0
          ? ctx.externalAppsBlock
          : "_No external apps connected._",
    },
  );
};
