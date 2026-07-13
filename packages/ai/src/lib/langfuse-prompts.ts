/**
 * Langfuse Prompt Management (via the shared `@langfuse/client`).
 *
 * The chatbot's system prompt + sub-agent prompt are managed prompts in
 * Langfuse: versioned, labelled, editable in the UI, and linkable to traces.
 * The `.md` files in the repo stay the source of truth for git review and
 * act as the seed + offline fallback.
 *
 * **Fetched per turn, not frozen at boot.** `prompt.get` is the intended
 * usage: the SDK caches client-side, so after the first call it returns
 * instantly with no network round-trip, and on TTL expiry it serves the
 * stale value immediately while revalidating in the background (never
 * blocking). The upside of per-turn fetch: a prompt edit / rollback / label
 * switch in the Langfuse UI goes live within the TTL — no redeploy.
 *
 * **Label follows the environment** (the documented best practice — prompts
 * are one shared pool, segregated only by label, not by the `environment`
 * trace attribute):
 *   - prod  → label `production`, SDK default cache (60s). The static prefix
 *             stays byte-identical across a conversation's turns, so the
 *             OpenRouter prompt cache is preserved; the text only changes
 *             when a human promotes a new `production` version.
 *   - dev   → label `latest`, caching disabled — always the newest edit, for
 *             instant iteration without redeploy or label juggling.
 *
 * No-op when Langfuse is unconfigured: returns the fallback text, no link.
 */
import { langfuseClient, langfuseEnvironment } from "./langfuse";

/**
 * Local prompt-source override. Set `LANGFUSE_PROMPTS_LOCAL=true` in a dev
 * `.env` to read the in-repo `.md` directly and SKIP Langfuse entirely: local
 * then runs whatever the `.md` currently says (your latest edit, picked up on
 * the next dev-server reload) while NOTHING is published to Langfuse — so the
 * `production` label, and therefore prod, stays exactly as it is. Tracing is
 * unaffected (this gates only the prompt source). NEVER set it in prod.
 */
const USE_LOCAL_PROMPTS = process.env.LANGFUSE_PROMPTS_LOCAL === "true";

/**
 * Per-environment fetch options. Production pins the promoted `production`
 * label (cached); every other environment tracks `latest` uncached so a UI
 * edit is visible on the next turn.
 */
const FETCH_OPTIONS =
  langfuseEnvironment === "production"
    ? { label: "production", type: "text" as const }
    : { label: "latest", type: "text" as const, cacheTtlSeconds: 0 };

/**
 * A managed-prompt version reference the `@langfuse/vercel-ai-sdk` integration
 * links to a model-call observation. Read off the agent's `runtimeContext`
 * under the `langfusePrompt` key (opted in via `telemetry.includeRuntimeContext`);
 * the integration normalizes exactly `{ name, version, isFallback? }`.
 */
export interface LangfusePromptRef {
  name: string;
  version: number;
  isFallback?: boolean;
}

/** A managed prompt's resolved template text plus its trace-link payload. */
export interface ManagedPrompt {
  /**
   * Raw template text, verbatim — `{{placeholders}}` and HTML comments
   * intact. The caller strips comments and runs its own `renderPrompt()`;
   * we never use Langfuse's `compile()`.
   */
  text: string;
  /**
   * `{ name, version }` of the resolved Langfuse version, surfaced to the
   * telemetry integration for prompt-version linking. `undefined` on fallback
   * resolution — linking a trace to a non-existent version would mislead.
   */
  promptRef?: LangfusePromptRef;
}

/**
 * Fetch a managed prompt by name, falling back to `fallbackText` when
 * Langfuse is unconfigured, the prompt is missing, or the server is
 * unreachable with an empty cache. Soft-fail: never throws, so a Langfuse
 * outage can never break a turn.
 */
export const fetchManagedPrompt = async (
  name: string,
  fallbackText: string,
): Promise<ManagedPrompt> => {
  if (USE_LOCAL_PROMPTS || !langfuseClient) return { text: fallbackText };
  try {
    const prompt = await langfuseClient.prompt.get(name, {
      ...FETCH_OPTIONS,
      fallback: fallbackText,
    });
    return prompt.isFallback
      ? { text: prompt.prompt }
      : {
          text: prompt.prompt,
          promptRef: { name: prompt.name, version: prompt.version },
        };
  } catch (err) {
    console.warn(
      `[langfuse] fetchManagedPrompt(${name}) failed, using fallback:`,
      err instanceof Error ? err.message : err,
    );
    return { text: fallbackText };
  }
};
