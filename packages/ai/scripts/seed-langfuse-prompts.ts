#!/usr/bin/env bun
/**
 * Seed / update the chatbot's managed prompts in Langfuse Prompt Management.
 *
 * Reads the repo `.md` prompts (the git source of truth), STRIPS the HTML
 * maintainer comments (the architecture docblock + the DYNAMIC SUFFIX marker
 * — dev documentation that belongs in git, not the prompt registry), and
 * publishes each as a `production`-labelled TEXT prompt — but ONLY when the
 * content differs from the current `production` version, so re-runs never
 * stack no-op versions. Idempotent: run once to bootstrap, and again after
 * editing a `.md` you want to promote.
 *
 * Stripping here means the prompt STORED in Langfuse is byte-identical to what
 * the model receives at runtime (minus the dynamic `{{variables}}` injected
 * per turn) — so the Langfuse Playground, experiments, and version diffs all
 * operate on the real prompt, not on commented-out dev notes the runtime
 * strips anyway (`agents/shared/prompt-renderer.ts`).
 *
 * Names + paths mirror `MANAGED_PROMPTS` in
 * `src/agents/shared/prompt-renderer.ts`. Kept in sync by hand on purpose:
 * importing the renderer would pull the agent module graph (DB / Redis /
 * OTel bootstrap) into a plain seeding script.
 *
 * Usage: `bun run langfuse:seed-prompts` (needs LANGFUSE_* in `.env`).
 */
import { LangfuseClient } from "@langfuse/client";

const PROJECT_ROOT = `${import.meta.dir}/..`;

/**
 * Strip `<!-- … -->` HTML comments — MUST match the runtime stripper in
 * `agents/shared/prompt-renderer.ts` (`HTML_COMMENT_RE`) so the stored prompt
 * equals the runtime template. Duplicated (not imported) to keep this script
 * free of the agent module graph.
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

const toStoredPrompt = (raw: string): string =>
  raw.replace(HTML_COMMENT_RE, "").trim();

const PROMPTS = [
  {
    name: "fretik-chatbot-system",
    path: `${PROJECT_ROOT}/src/agents/chatbot/system-prompt.md`,
  },
  {
    name: "fretik-chatbot-sub-agent",
    path: `${PROJECT_ROOT}/src/agents/chatbot/sub-agent-system-prompt.md`,
  },
] as const;

const client = new LangfuseClient();

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

const seed = async (): Promise<void> => {
  for (const { name, path } of PROMPTS) {
    const text = toStoredPrompt(await Bun.file(path).text());
    const exists = await hasProductionVersion(name);
    if (exists) {
      const current = await client.prompt.get(name, {
        label: "production",
        type: "text",
        cacheTtlSeconds: 0,
      });
      if (current.prompt === text) {
        console.log(`✓ ${name} — unchanged, skipped`);
        continue;
      }
    }
    await client.prompt.create({
      name,
      type: "text",
      prompt: text,
      labels: ["production"],
    });
    console.log(
      exists
        ? `↑ ${name} — new version published (production)`
        : `+ ${name} — created (production)`,
    );
  }
};

await seed();
