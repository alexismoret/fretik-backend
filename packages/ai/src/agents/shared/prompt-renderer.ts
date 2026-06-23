import { fetchManagedPrompt } from "../../lib/langfuse-prompts";
import type { NativeInputPolicy } from "../../lib/model-registry/types";
import { buildSessionStateBlock } from "../../services/session-state/build-block";
import type { SearchableToolRegistry } from "./chatbot-tool";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * Dynamic-suffix note (C5) telling the model that attachments of the
 * modalities its profile sends native are directly visible — so it should
 * answer from what it sees rather than reach for `vision`. Empty for inert
 * / non-multimodal profiles, keeping the rendered prompt byte-identical to
 * today. Below the cache marker, so it never touches the static prefix.
 */
const buildNativeMediaNote = (nativeInput: NativeInputPolicy): string => {
  const kinds: string[] = [];
  if (nativeInput.image) kinds.push("images");
  if (nativeInput.video) kinds.push("videos");
  if (kinds.length === 0) return "";
  return `**Attached ${kinds.join(" and ")} are directly visible to you in this message** — describe and answer from what you see. Call \`vision\` only for a finer visual sub-question (a region of an image, a specific moment of a video).`;
};

/**
 * Pure prompt template renderer used by the chatbot agent.
 *
 * The Markdown template lives at `agents/chatbot/system-prompt.md` and
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

const TEMPLATE_URL = new URL("../chatbot/system-prompt.md", import.meta.url);
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
  system: { name: "fretik-chatbot-system", url: TEMPLATE_URL },
  subAgent: { name: "fretik-chatbot-sub-agent", url: SUB_AGENT_TEMPLATE_URL },
} as const;

/**
 * Raw `.md` text (HTML comments INTACT) — the Langfuse fallback used when the
 * managed prompt can't be fetched, and the seed source. Comments are stripped
 * per turn after fetch, so keeping them in the stored/fallback text leaves the
 * architecture docblock + DYNAMIC SUFFIX marker visible to whoever edits the
 * prompt in the Langfuse UI.
 */
const SYSTEM_PROMPT_FALLBACK = await Bun.file(TEMPLATE_URL).text();
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
  const { text, link } = await fetchManagedPrompt(
    MANAGED_PROMPTS.subAgent.name,
    SUB_AGENT_FALLBACK,
  );
  ctx.langfusePromptLink = link;
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

const formatCurrentDate = (
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
 * (`.agent/agent-facing-prose.md`: growth without sharpening is a
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
  const { text, link } = await fetchManagedPrompt(
    MANAGED_PROMPTS.system.name,
    SYSTEM_PROMPT_FALLBACK,
  );
  ctx.langfusePromptLink = link;
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
      skillsCatalog:
        ctx.enabledSkillsBlock && ctx.enabledSkillsBlock.length > 0
          ? ctx.enabledSkillsBlock
          : "_No skills enabled for this team._",
      attachedFilesBlock:
        ctx.attachedFilesBlock && ctx.attachedFilesBlock.length > 0
          ? ctx.attachedFilesBlock
          : "_No files attached to the current message._",
      nativeMediaNote: buildNativeMediaNote(
        ctx.modelProfile.assessment.nativeInput,
      ),
      chatbotContextManifest:
        ctx.chatbotContextManifest && ctx.chatbotContextManifest.length > 0
          ? ctx.chatbotContextManifest
          : "_No persistent context configured._",
      sessionStateBlock: (() => {
        const block = buildSessionStateBlock({
          dynamicToolManager: ctx.dynamicToolManager,
          taskManager: ctx.taskManager,
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
