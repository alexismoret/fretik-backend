import type { ModelProfile, ModelRole, RoleBinding } from "../types";
import { ANTHROPIC_PROFILES } from "./anthropic";
import { DEEPSEEK_PROFILES } from "./deepseek";
import { GOOGLE_PROFILES } from "./google";
import { MINIMAX_PROFILES } from "./minimax";
import { MISTRAL_PROFILES } from "./mistral";
import { OPENAI_PROFILES } from "./openai";
import { THINKING_MACHINES_PROFILES } from "./thinkingmachines";
import { XAI_PROFILES } from "./xai";
import { ZAI_PROFILES } from "./zai";

/**
 * The model registry — one file per brand, assembled here.
 *
 * **Breadth is the product.** 23 profiles across 9 families, and the intent is
 * that this list keeps growing: a team should be able to plug in whichever
 * current model suits it. Two rules keep that from turning into sprawl:
 *
 * 1. **Latest version only.** When a family ships a new generation the old
 *    profile is REMOVED, not kept alongside. Removals so far:
 *    `claude-opus-4.8` / `claude-sonnet-4.6` → Claude Opus 5 / Sonnet 5,
 *    `gpt-5.5` → the GPT-5.6 trio, `glm-5.1` + `glm-4.7` → GLM-5.2,
 *    `gpt-4o-mini` (orphaned, `tiers: []`).
 * 2. **Selection is gated by `assessment.enabled` and nothing else.** The old
 *    rule — flagship models had to carry `evalGate.status === "passed"` — was
 *    removed on 2026-07-26: it had frozen the flagship menu at two models
 *    while twelve sat `pending`, and it made a slow, expensive suite the
 *    gatekeeper of product breadth. Evals now gate exactly one thing, the
 *    APPLIED DEFAULT below.
 *
 * Catalog blocks were read from the OpenRouter models API on 2026-07-26; run
 * `bun run models:check` after any provider announcement to re-verify them,
 * and `--probe` to catch a profile whose routing pool has gone empty.
 *
 * Which brands ship: Anthropic, OpenAI, Google, Mistral, MiniMax, DeepSeek,
 * Z.ai, xAI, Thinking Machines. Qwen is intentionally absent — it has no
 * zero-data-retention endpoint on OpenRouter (see `ModelFamily`).
 *
 * The eval judge (`evals/judge.ts`) intentionally stays OUTSIDE the registry:
 * it must remain a different family from the serving models.
 */
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  ...ANTHROPIC_PROFILES,
  ...OPENAI_PROFILES,
  ...GOOGLE_PROFILES,
  ...MISTRAL_PROFILES,
  ...MINIMAX_PROFILES,
  ...DEEPSEEK_PROFILES,
  ...ZAI_PROFILES,
  ...XAI_PROFILES,
  ...THINKING_MACHINES_PROFILES,
};

/**
 * Default role → profile bindings. Pure code — model env vars are
 * GONE: changing a default is a reviewed PR, per-team / per-conversation
 * overrides come from the DB (C8).
 *
 * **This is the eval-gated surface.** `model-registry.test.ts` requires the
 * profile bound to `chat` and `workflow` to carry `evalGate.status ===
 * "passed"`, so promoting a new default (e.g. `minimax-m3` → `gpt-5.6-luna`)
 * fails CI without a gate run: `bun run evals:gate -- --candidate <key>`.
 * Merely OFFERING a model to teams requires no eval evidence at all.
 *
 * A binding resolves its profile directly and bypasses `isSelectableForTier`,
 * so a role may legitimately point at an `enabled: false` profile — see
 * `transform-fallback` → `gemini-3.6-flash`.
 */
export const ROLE_BINDINGS: Record<ModelRole, RoleBinding> = {
  // Gated flip 2026-08-02 (run 8e3ea13a8b4b3968): minimax-m3 → deepseek-v4-flash.
  // Faster (56.3s → 30.8s avg), ~2.9× cheaper per turn, ahead on reasoning and
  // tool-use, and it needs none of M3's mitigations (no `replayInHistory`
  // strip, no orphan-`</think>` stripper). The displaced M3 becomes
  // `chat-fallback` below, which keeps primary and fallback on different
  // families and different upstreams.
  chat: {
    role: "chat",
    profileKey: "deepseek-v4-flash",
    settingsKind: "chat",
    wrapCache: true,
  },
  // Deliberately a DIFFERENT family and a different upstream from `chat`:
  // this binding exists for the turns where the primary died, so sharing
  // DeepSeek's weights or DeepInfra's capacity with it would let one incident
  // take out both. minimax-m3 was the gate-passing default until 2026-08-02,
  // routes via Novita, and carries its own mitigations (`replayInHistory:
  // false`, the orphan-`</think>` stripper) — they apply here too, since the
  // escalation swaps the PROFILE, not just the agent.
  "chat-fallback": {
    role: "chat-fallback",
    profileKey: "minimax-m3",
    settingsKind: "chat",
    wrapCache: true,
  },
  // Autonomous workflow executor. Defaults to the SAME profile as `chat`
  // (reliability first — the priority order is precision > cost) and follows
  // the team's flagship tier pick; a workflow may override per-run via its
  // `modelProfileKey`. The agent already delegates mechanical sub-tasks to the
  // cheap model via `dispatchAgent`, so the default need not be the cheap one.
  // Tracks `chat` (reliability first) — flipped in the same gated change.
  workflow: {
    role: "workflow",
    profileKey: "deepseek-v4-flash",
    settingsKind: "chat",
    wrapCache: true,
  },
  "dispatch-cheap": {
    role: "dispatch-cheap",
    profileKey: "deepseek-v4-flash",
    settingsKind: "chat",
    wrapCache: true,
  },
  "pre-extract": {
    role: "pre-extract",
    profileKey: "deepseek-v4-flash",
    settingsKind: "preextract",
    wrapCache: true,
  },
  "pre-extract-fallback": {
    role: "pre-extract-fallback",
    profileKey: "gpt-oss-120b",
    settingsKind: "preextract",
    wrapCache: true,
  },
  "active-memory": {
    role: "active-memory",
    // P5-bis recall-eval decision (2026-07, 16-case suite × 3 repeats):
    // gpt-oss-120b @ effort medium @ 10k output budget → 16/16 at
    // p50 ~1.3s; gpt-oss-20b topped out at 15/16 with double latency;
    // deepseek-v4-flash timed out (13-15s — measured on the April model the
    // key then pointed at, superseded by 0731 on 2026-08-02). The judge is a SYSTEM
    // quality component — ROLE_TIER pins it "fixed" so a team's utility
    // pick can't degrade it. NOTE: the old 3k judge output budget
    // silently truncated gpt-oss REASONING at medium/high effort and
    // collapsed both models to NONE — budget sits in recall.ts now.
    profileKey: "gpt-oss-120b",
    settingsKind: "recall",
    wrapCache: false,
  },
  "memory-extract": {
    role: "memory-extract",
    profileKey: "gpt-oss-20b",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "memory-distill": {
    role: "memory-distill",
    profileKey: "gpt-oss-20b",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "memory-consolidate": {
    role: "memory-consolidate",
    // P8.2 memory-eval decision: the consolidation judge (MERGE/REVISE/NOOP +
    // temporal re-anchoring of a plan whose date is now past) needs judgment
    // gpt-oss-20b delivers unreliably — the reanchor case NOOP'd 1-2/3.
    // gpt-oss-120b @ effort low → reanchor 5/5, merge/revise/noop stable.
    // Split from `memory-distill` on purpose: consolidation is low-volume
    // (nightly per-cluster + eager per just-distilled episode), so the ~3x
    // model cost lands on a fraction of the (high-volume) distill traffic.
    profileKey: "gpt-oss-120b",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "compaction-summarizer": {
    role: "compaction-summarizer",
    profileKey: "deepseek-v4-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
  "cheap-tasks": {
    role: "cheap-tasks",
    profileKey: "gpt-oss-20b",
    settingsKind: "bare",
    wrapCache: false,
  },
  // One-shot malformed-tool-call repair (`repair-tool-call.ts`). Split from
  // `dispatch-cheap` (2026-07): deepseek-v4-flash hit the 20s repair timeout
  // in prod, turning every repair into pure wasted latency — same failure the
  // recall eval documented, same fix (gpt-oss-120b, ~6x faster). Measured on
  // the April model; the key points at 0731 since 2026-08-02, which is much
  // faster on the pinned upstream — worth re-testing before assuming it still
  // holds.
  "tool-repair": {
    role: "tool-repair",
    profileKey: "gpt-oss-120b",
    settingsKind: "bare",
    wrapCache: false,
  },
  // ONE file-capable model backs BOTH the `vision` tool (free-text visual
  // questions) and the `extract` engine (schema-guided structured output) —
  // the dimension that matters is native input (PDF/image), not "describe vs
  // extract", so there is no separate extraction role. WS0 replay (2026-07-24,
  // 40-page customs DAE) proved gemini-3.6-flash + reasoning `minimal` + NO
  // temperature + a 60K output cap extracts all 43 line items with every field,
  // clean numbers, and correct cross-copy dedup in ONE call (~30s). Two failure
  // modes it fixes: `temperature:0` returns EMPTY on Gemini 3.x (temp is dropped
  // on the Vertex ZDR route anyway, and low temp makes it loop), and reasoning
  // tokens count against the output cap — an 8K/32K cap was consumed by
  // mandatory thinking → `length` cutoff → "No output generated." The `extract`
  // engine (`lib/structured-extract.ts`) and the `vision` call own reasoning
  // `{effort:"minimal"}` + no-temperature per call.
  //
  // Bound to gemini-3.5-flash-lite since 2026-07-25 (5× cheaper input / 3×
  // output than 3.6-flash). Its earlier exclusion — "mandatory reasoning runs
  // away past 60K on dense docs" — did NOT reproduce on re-measurement: on the
  // 2026-07-24 prod fixtures it returned every record on 12/12 free-form runs
  // (5-page slice 28/28 ×8 at efforts minimal AND low, 40-page 43/43 ×4,
  // 14-48s, cleaner values than 3.6-flash) and 6/6 under constrained decoding.
  // The old ruling was measured under `require_parameters` (since removed from
  // `bare`, which emptied its Vertex ZDR pool) and `temperature:0` (empty
  // output on Gemini 3.x) — those conditions, not the model.
  // Extraction is the MEASURED dimension; free-text visual Q&A rides the same
  // binding untested — watch the `vision` traces after the switch.
  vision: {
    role: "vision",
    profileKey: "gemini-3.5-flash-lite",
    settingsKind: "bare",
    wrapCache: false,
  },
  // Fast, reliably-routing, ~10× cheaper fallback (thinking-off, no temperature):
  // less complete per-record than 3.6-flash, but a solid second attempt when the
  // primary's endpoint is unavailable.
  "vision-fallback": {
    role: "vision-fallback",
    profileKey: "gemini-3.1-flash-lite",
    settingsKind: "bare",
    wrapCache: false,
  },
  // Document-scale prose transformation (the `transform` tool): translate,
  // rewrite, restyle a whole document chunk-by-chunk. Separate from the
  // `extract` roles on purpose — extract is native-PDF/vision-pinned, whereas
  // transform is text-in/text-out and wants a fast, strongly-multilingual
  // workhorse. `bare`: the engine owns per-call options (temperature 0, output
  // cap). No cache wrap — chunk calls are independent one-shots.
  transform: {
    role: "transform",
    profileKey: "deepseek-v4-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
  // Different family from the primary (deepseek), strong on multilingual
  // prose — the observed failure class is a truncated or refused chunk, and a
  // family swap is the most effective second attempt.
  //
  // Points at an `enabled: false` profile ON PURPOSE: gemini-3.6-flash is too
  // expensive to OFFER as a team pick (4.06× an M3 turn) but is the right
  // second attempt on a low-volume fallback path. Role bindings bypass
  // `isSelectableForTier`, so this is legal and intended.
  "transform-fallback": {
    role: "transform-fallback",
    profileKey: "gemini-3.6-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
};
