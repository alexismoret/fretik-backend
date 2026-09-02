import { LangfuseClient } from "@langfuse/client";
// PURE module (zero imports) — safe here: pulls none of the agent module
// graph (DB / Redis / OTel). It is the SINGLE resolver shared with the
// runtime fallback path, so seed-time and fallback resolution can't drift.
import {
  resolveAgentBlocks,
  type PromptAgentKind,
} from "../../agents/shared/prompt-blocks";

/**
 * Publish the repo's managed prompts to Langfuse Prompt Management.
 *
 * Reads the `.md` prompts (the git source of truth), STRIPS the HTML
 * maintainer comments (the architecture docblock + the DYNAMIC SUFFIX marker
 * — dev documentation that belongs in git, not the prompt registry), and
 * publishes each as a `production`-labelled TEXT prompt — but ONLY when the
 * content differs from the current `production` version, so re-runs never
 * stack no-op versions.
 *
 * Stripping here means the prompt STORED in Langfuse is byte-identical to what
 * the model receives at runtime (minus the dynamic `{{variables}}` injected
 * per turn) — so the Langfuse Playground, experiments, and version diffs all
 * operate on the real prompt, not on commented-out dev notes the runtime
 * strips anyway (`agents/shared/prompt-renderer.ts`).
 *
 * Extracted from `scripts/seed-langfuse-prompts.ts` on 2026-09-02 so the AI
 * service can run it as a RELEASE TASK — once per deployed version, without
 * anyone remembering. The script still exists and still works; it now calls
 * this. What makes it safe to automate is the diff check above: a deploy that
 * changes no prompt publishes nothing, and a version that IS published is one
 * Langfuse keeps beside its predecessors.
 *
 * Names + paths mirror `MANAGED_PROMPTS` in
 * `agents/shared/prompt-renderer.ts`. Kept in sync by hand on purpose:
 * importing the renderer would pull the agent module graph (DB / Redis /
 * OTel bootstrap) into a module the boot calls before it is ready.
 */

/** `src/lib/langfuse-prompts` → the package root. */
const PROJECT_ROOT = `${import.meta.dir}/../../..`;

/**
 * Strip `<!-- … -->` HTML comments — MUST match the runtime stripper in
 * `agents/shared/prompt-renderer.ts` (`HTML_COMMENT_RE`) so the stored prompt
 * equals the runtime template. Duplicated (not imported) to keep this module
 * free of the agent module graph.
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

const toStoredPrompt = (raw: string): string =>
  raw.replace(HTML_COMMENT_RE, "").trim();

/**
 * The unified agent template is resolved PER AGENT here, at seed time — the
 * stored Langfuse prompts (`fretik-chatbot-system`, `fretik-workflow-system`)
 * are the final per-agent texts, byte-identical to what the runtime renders
 * (minus per-turn `{{variables}}`): easy to debug in the Playground, and the
 * OpenRouter prefix cache stays keyed on stable per-agent prompts. The
 * runtime never resolves blocks on fetched text.
 */
const UNIFIED_PROMPT_PATH = `${PROJECT_ROOT}/src/agents/shared/agent-system-prompt.md`;

/**
 * Exported so a test can assert every path RESOLVES.
 *
 * `PROJECT_ROOT` is relative to this file, and this file moved out of
 * `scripts/` on 2026-09-02 — a wrong depth here reads perfectly, typechecks,
 * and fails only inside the container, on every deploy, in a task nobody is
 * watching. Cheapest possible guard against the cheapest possible mistake.
 */
export const PROMPTS: readonly {
  name: string;
  path: string;
  agent?: PromptAgentKind;
}[] = [
  {
    name: "fretik-chatbot-system",
    path: UNIFIED_PROMPT_PATH,
    agent: "chatbot",
  },
  {
    name: "fretik-workflow-system",
    path: UNIFIED_PROMPT_PATH,
    agent: "workflow",
  },
  {
    name: "fretik-chatbot-sub-agent",
    path: `${PROJECT_ROOT}/src/agents/chatbot/sub-agent-system-prompt.md`,
  },
  {
    name: "fretik-page-builder",
    path: `${PROJECT_ROOT}/src/agents/chatbot/page-builder-system-prompt.md`,
  },
] as const;

/**
 * Cache-stability guard: the static prefix must stay byte-identical across
 * turns, so the only `{{placeholders}}` allowed ABOVE the DYNAMIC SUFFIX
 * marker are the team-stable ones (constant within a conversation). Any new
 * placeholder in the static zone silently kills the OpenRouter prefix cache —
 * fail the seed instead.
 */
const STATIC_ZONE_ALLOWED_PLACEHOLDERS = new Set([
  "deferredToolList",
  "skillsCatalog",
  "externalAppsBlock",
]);
const DYNAMIC_MARKER = "DYNAMIC SUFFIX — every section below";

const assertStaticPrefixStable = (name: string, resolved: string): void => {
  const markerIdx = resolved.indexOf(DYNAMIC_MARKER);
  if (markerIdx === -1) {
    throw new Error(`${name}: DYNAMIC SUFFIX marker not found in template`);
  }
  const staticZone = resolved.slice(0, markerIdx);
  const offenders = [...staticZone.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g)]
    .map((m) => m[1] ?? "")
    .filter((p) => !STATIC_ZONE_ALLOWED_PLACEHOLDERS.has(p));
  if (offenders.length > 0) {
    throw new Error(
      `${name}: placeholder(s) above the DYNAMIC SUFFIX marker break the cache prefix: ${offenders.join(", ")}`,
    );
  }
};

export interface SeedPromptsResult {
  /** Prompts whose text differed and now have a new `production` version. */
  published: string[];
  /** Prompts already identical to what Langfuse serves. */
  unchanged: string[];
}

/**
 * Whether the three variables the Langfuse client needs are all present.
 *
 * Exported because the CALLER decides what a missing credential means: the
 * script says so and exits, the release task simply does not register — which
 * leaves no ledger row, so the day the credentials arrive the task runs
 * instead of being remembered as done.
 */
export const langfuseCredentialsPresent = (): boolean =>
  Boolean(
    process.env["LANGFUSE_PUBLIC_KEY"] &&
    process.env["LANGFUSE_SECRET_KEY"] &&
    process.env["LANGFUSE_BASE_URL"],
  );

export const seedLangfusePrompts = async (): Promise<SeedPromptsResult> => {
  const client = new LangfuseClient();
  const published: string[] = [];
  const unchanged: string[] = [];

  /**
   * Whether a `production`-labelled version of this prompt already exists.
   * Uses the list endpoint (returns an empty page for a missing name) rather
   * than `prompt.get` — the latter 404s on a fresh prompt, which the SDK logs
   * loudly at ERROR even when caught.
   */
  const hasProductionVersion = async (name: string): Promise<boolean> => {
    const list = await client.api.prompts.list({
      name,
      label: "production",
      limit: 1,
    });
    return list.data.some((p) => p.name === name);
  };

  for (const { name, path, agent } of PROMPTS) {
    const raw = await Bun.file(path).text();
    if (agent !== undefined) {
      assertStaticPrefixStable(name, resolveAgentBlocks(raw, agent));
    }
    const text = toStoredPrompt(
      agent === undefined ? raw : resolveAgentBlocks(raw, agent),
    );
    const exists = await hasProductionVersion(name);
    if (exists) {
      const current = await client.prompt.get(name, {
        label: "production",
        type: "text",
        cacheTtlSeconds: 0,
      });
      if (current.prompt === text) {
        unchanged.push(name);
        continue;
      }
    }
    await client.prompt.create({
      name,
      type: "text",
      prompt: text,
      labels: ["production"],
    });
    published.push(name);
  }

  return { published, unchanged };
};
