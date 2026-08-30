import type { OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import { getProfileForRole, listProfiles } from "./model-registry/resolve";

/**
 * OpenRouter model id for "cheap, short extraction" one-shots — the
 * registry's `cheap-tasks` role (default `openai/gpt-oss-20b`).
 * Shared by:
 *   - Phase 7b contextual enrichment (services/vectorize/contextual-enrichment.ts)
 *   - Phase 7c multi-query reformulation  (services/search/multi-query.ts)
 *   - catch-up summaries                  (services/catch-up-summary.ts)
 *   - conversation titles                 (services/conversation-title/generate.ts)
 *
 * Call sites pass their own per-call settings (`reasoning`, etc.) to
 * `openrouter.chat(CHEAP_MODEL, …)` — the registry only owns WHICH
 * model serves the role. Changing it is a reviewed edit to
 * `model-registry/profiles.ts`.
 */
export const CHEAP_MODEL = getProfileForRole("cheap-tasks").catalog.id;

/**
 * Provider policy for those same one-shots. The registry owns WHICH model; it
 * has to own WHERE the model runs too, because "cheap" never meant "outside the
 * data-retention and quality guarantees the rest of the fleet honours".
 *
 * These four call sites were passing settings with NO `provider` block at all,
 * so they inherited none of it. Measured 2026-08-03 over 58 enrichment calls:
 * 19 landed on CoreWeave (fp4) and 13 on SiliconFlow (fp8) — 55% on quantized
 * servings, and SiliconFlow ran 5.8 s median against Groq's 0.4 s. That matters
 * more here than the price suggests: enrichment's output becomes the
 * `contextualPrefix` prepended to EVERY chunk, and the reranker scores prefix +
 * content, so this one call sets the retrieval precision of the whole memory
 * system. `zdr` is the graver half — these prompts carry raw document and
 * conversation text.
 *
 * No `require_parameters`, for the same reason `bare` roles omit it: these are
 * one-shots that never tool-call, and the flag narrows routing to providers
 * advertising every parameter sent — which empties the pool rather than
 * dropping a field.
 *
 * `zdr` is read from the profile actually being served, never hardcoded: three
 * of these four call sites resolve the model PER TEAM, and a team may pick a
 * profile with no ZDR endpoint (`ministral-8b-2512`, `mistral-small-2603`).
 * Asserting `zdr: true` there would empty the pool — a 404 on every call —
 * rather than downgrade.
 */
export const cheapProviderFor = (
  modelId: string,
): NonNullable<OpenRouterChatSettings["provider"]> => {
  // The EFFECTIVE list: a team's cheap model can be one promoted by a write,
  // and reading its provider policy off the curated fallback instead would
  // apply a different model's routing decisions to it.
  const served =
    listProfiles().find((p) => p.catalog.id === modelId) ??
    getProfileForRole("cheap-tasks");
  const { zdr, ignore } = served.assessment.provider;
  return {
    zdr,
    // Same floor as the memory judges: a quantized 20b loses output discipline.
    quantizations: ["bf16", "fp16", "unknown"],
    // Read from the profile, never hardcoded — the Fireworks exclusion is a
    // fact about gpt-oss (see `profiles/openai.ts`), and these call sites
    // resolve the model PER TEAM. Hardcoding it removed the endpoint from
    // models the measurement never covered.
    ...(ignore ? { ignore: [...ignore] } : {}),
    // Without this the block expressed no speed preference at all, so these
    // calls ran on OpenRouter's DEFAULT price ordering — which is how the
    // 5.8 s median above happened. Nothing here needs the cache stickiness that
    // makes the agent loop's pool a delicate choice: every one of these is a
    // one-shot over content that never repeats, so there is no warm prefix to
    // lose by moving upstream. Latency is the only axis left that matters, and
    // enrichment sits on the critical path of every indexed chunk.
    sort: "throughput",
  };
};

/** The policy for the static `CHEAP_MODEL` (the non-team-aware call sites). */
export const CHEAP_PROVIDER = cheapProviderFor(CHEAP_MODEL);
