import { getSkillCatalog } from "../../skills/materialize";
import type { SearchableToolRegistry } from "./chatbot-tool";
import type { AgentRuntimeContext } from "./runtime-context";

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

/**
 * Match `<!-- ... -->` blocks (including multi-line). The trailing
 * newline is consumed when the comment occupies its own line, so
 * stripping doesn't leave dangling blank lines.
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

const RAW_SYSTEM_PROMPT_TEMPLATE = await Bun.file(TEMPLATE_URL).text();

const SYSTEM_PROMPT_TEMPLATE = RAW_SYSTEM_PROMPT_TEMPLATE.replace(
  HTML_COMMENT_RE,
  "",
);

/**
 * Format a `Date` the same way the Claude reference prompt does but
 * with the current time and an explicit timezone suffix:
 * `Tuesday, February 17, 2026, 15:45 (Europe/Paris, GMT+2)`.
 *
 * Uses `en-US` locale explicitly so the output is stable regardless of
 * the server's locale settings, and forces 24h time (`hour12: false`)
 * so logistics data — where 15:00 vs 03:00 really matters — is never
 * ambiguous. The timezone is resolved from the client (Nuxt app sends
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
 * Render the `{{skillsCatalog}}` placeholder — the progressive-disclosure
 * L1 listing of bundled skills. Only the name + description are injected
 * into the system prompt; the agent reads `skills/{name}/SKILL.md` via
 * the existing `read` tool when a skill becomes relevant, matching
 * Anthropic's API Skills model exactly (filesystem + read, no bespoke
 * loadSkill tool).
 */
const formatSkillsCatalog = (): string => {
  const catalog = getSkillCatalog();
  if (catalog.length === 0) {
    return "_No bundled skills available._";
  }
  return catalog
    .map((entry) => `- **${entry.name}** — ${entry.description}`)
    .join("\n");
};

/**
 * Build the chatbot system prompt for a given runtime context.
 *
 * `deferredTools` defaults to an empty set so callers can build the
 * prompt with no domain catalogue. The agent-builder always passes
 * the full domain-tool registry so `{{deferredToolList}}` reflects
 * what `searchTools` can activate.
 */
export const buildChatbotSystemPrompt = (
  ctx: AgentRuntimeContext,
  deferredTools: SearchableToolRegistry = {},
): string => {
  return renderPrompt(SYSTEM_PROMPT_TEMPLATE, {
    currentDate: formatCurrentDate(new Date(), ctx.timeZone),
    userName: ctx.userName ?? "Unknown user",
    userId: ctx.userId ?? "unknown",
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    conversationId: ctx.conversationId ?? "unknown",
    deferredToolList: formatDeferredToolList(deferredTools),
    skillsCatalog: formatSkillsCatalog(),
    attachedFilesBlock:
      ctx.attachedFilesBlock && ctx.attachedFilesBlock.length > 0
        ? ctx.attachedFilesBlock
        : "_No files attached to the current message._",
    chatbotContextManifest:
      ctx.chatbotContextManifest && ctx.chatbotContextManifest.length > 0
        ? ctx.chatbotContextManifest
        : "_No persistent context configured._",
  });
};
