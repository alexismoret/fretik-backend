import type { RoutingSort } from "@fretik/shared/model-registry/types";

/**
 * The shape a resolved model has — every field of it DERIVED, none written by
 * hand.
 *
 * There is no file of profiles behind this type any more. `effective.ts` builds
 * one `ModelProfile` per `model_live_state` row: `catalog` from what the
 * catalogues publish about the model, `assessment` from what its prices and its
 * endpoints imply. The two halves are kept apart because they answer different
 * questions — `catalog` is "what does the model accept upstream", `assessment`
 * is "what does that mean for us" — and mixing them is how a policy ends up
 * looking like a fact.
 *
 * Design rules that survive:
 *
 * - **No model env vars.** `ROLE_BINDINGS` (`role-bindings.ts`) holds the code
 *   defaults; per-team and per-conversation selection comes from the database.
 *   Changing a default model is a reviewed pull request, not an env edit.
 * - **Selection is open; only the DEFAULT is eval-gated.** Which models a team
 *   may reach is governed by `assessment.enabled` alone — a value the row owns.
 *   Evals gate exactly one thing: binding a model as an APPLIED DEFAULT for
 *   `chat` / `workflow`, enforced by `model-registry.test.ts` and not by a
 *   runtime filter. The product is breadth; a model that underperforms on our
 *   tools is the team's call to swap, not a gate's call to hide.
 * - **A missing signal answers `unknown`, never `false`.** An optional field
 *   left absent means nothing measured it. Nothing may read that as a denial.
 */

/**
 * Native modality vocabulary — identical to OpenRouter's `architecture` arrays.
 *
 * Runtime tuples rather than bare unions, for the same reason `REASONING_LEVELS`
 * is one: a modality now arrives as a plain `string` from a catalogue, and the
 * only way to narrow it without a cast is to filter against the members. A
 * value we do not model yet is DROPPED there — it would otherwise describe a
 * content part nothing knows how to build.
 */
export const INPUT_MODALITIES = [
  "text",
  "image",
  "file",
  "audio",
  "video",
] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

export const OUTPUT_MODALITIES = ["text", "image", "audio"] as const;
export type OutputModality = (typeof OUTPUT_MODALITIES)[number];

/**
 * OpenRouter `supported_parameters` values the product actually reads. The
 * catalog stores the raw list verbatim, so a drift check is exact.
 */
export type SupportedParameter =
  | "tools"
  | "tool_choice"
  | "reasoning"
  | "include_reasoning"
  | "response_format"
  | "structured_outputs"
  | "max_tokens"
  | (string & {});

/**
 * Facts mirrored from the OpenRouter models API (GET /api/v1/models).
 * Field names track theirs 1:1 (camelCased) — keep it that way so
 * `scripts/check-model-catalog.ts` can diff mechanically. Last full
 * sync: 2026-08-26.
 */
export interface ModelCatalogFacts {
  /** OpenRouter model id, e.g. `minimax/minimax-m3`. */
  id: string;
  /** `context_length` — feeds the compaction threshold (C2). */
  contextLength: number;
  /** `top_provider.max_completion_tokens`; omitted when upstream reports null. */
  maxCompletionTokens?: number;
  /** `architecture.input_modalities`, verbatim. */
  inputModalities: readonly InputModality[];
  /** `architecture.output_modalities`, verbatim. */
  outputModalities: readonly OutputModality[];
  /** `supported_parameters`, verbatim. */
  supportedParameters: readonly SupportedParameter[];
  /**
   * `reasoning`, verbatim — OpenRouter publishes the reasoning contract per
   * model, so `assessment.reasoning` no longer has to be guessed:
   * - `mandatory`: reasoning cannot be disabled (Gemini, Grok) — never send
   *   `none` to these.
   * - `supportedEfforts`: the exact effort ladder. Absent ⇒ the model ignores
   *   the effort knob entirely and only honours a `max_tokens` budget
   *   (MiniMax M3, Claude Haiku 4.5) ⇒ `assessment.reasoning.style` must be
   *   `"max-tokens"`.
   *
   * Being catalog (not assessment) makes steerability DERIVABLE — see
   * `selectableReasoningLevels` (resolve.ts) — instead of a hand-kept key
   * list that rots.
   * Omitted entirely when the model has no reasoning support at all.
   *
   * The upstream's OWN default effort is deliberately not copied here. It is
   * recorded where it is read from (`dynamicProfile.reasoning.defaultEffort` on
   * the row) and nothing in the product consults it: which rung a model starts
   * on is decided by rule, not inherited — see `reasoningFromContract`.
   */
  reasoning?: {
    mandatory: boolean;
    supportedEfforts?: readonly ReasoningLevel[];
  };
}

/**
 * How prompt caching works for this model THROUGH OPENROUTER:
 * - `implicit`: upstream caches automatically on byte-stable prefixes.
 * - `explicit-breakpoints`: needs `cache_control` markers
 *   (`lib/openrouter-cache.ts` middleware).
 * - `none`: no caching documented — every token is full price.
 */
export type CacheStrategy = "implicit" | "explicit-breakpoints" | "none";

/** Which reasoning knob the model family honours on OpenRouter. */
export type ReasoningStyle = "max-tokens" | "effort" | "none";

/**
 * Product-level reasoning vocabulary — effort-first, the industry
 * convention (Claude.ai: effort + extended-thinking toggle; ChatGPT:
 * instant vs thinking) and fully aligned with OpenRouter's effort
 * scale (`max|xhigh|high|medium|low|minimal`). OpenRouter normalises
 * effort across providers (translating to budgets for budget-style
 * models), so this is the portable currency; `max_tokens` is never
 * exposed as a product knob. The level → wire-param mapping is
 * per-profile (C2) and re-baselined via evals, never guessed.
 *
 * `max` sits ABOVE `xhigh` and is real, not decorative: OpenRouter accepts
 * it on Luna / Terra / Sol / Opus 5 / Sonnet 5 / Inkling, and Artificial
 * Analysis measures GPT-5.6 Luna at 51.2 intelligence on `max` vs 49.1 on
 * `xhigh`. Some models (Kimi K3) even default to it upstream. Only ever
 * send a level a profile's `catalog.reasoning.supportedEfforts` lists.
 *
 * The user-facing surface is a THREE-LAYER default (2026-07-27): the
 * profile's `assessment.reasoning.defaultLevel`, overridden by the team's
 * stored choice for its flagship model, overridden by the level a user picks
 * for one chat turn or one workflow. Order enforced in `handlers/chatbot.ts`
 * and `handlers/workflow.ts`; the picker only ever offers levels from
 * `catalog.reasoning.supportedEfforts`.
 *
 * `REASONING_LEVELS` is the runtime tuple behind the union — the HTTP + DB
 * boundary needs actual values (`schemas/ai.ts` `reasoningLevelSchema` in
 * @fretik/shared). A unit test asserts the two stay identical.
 */
export const REASONING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/**
 * Brands whose latest models the product offers. One entry per vendor we
 * ship, plus `other` as the display fallback.
 *
 * `qwen` is retained deliberately with NO profile shipping: Qwen has no
 * zero-data-retention endpoint on OpenRouter at all (probed 2026-07-26 —
 * every request envelope returns HTTP 404 "No endpoints found matching your
 * data policy", Alibaba being the sole host). Keeping the family member
 * costs nothing and lets a Qwen profile land the day a ZDR host appears.
 */
/**
 * Families we have curated branding for. Not a closed world — see
 * `ModelFamily`.
 */
export type KnownModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "minimax"
  | "deepseek"
  | "qwen"
  | "zai"
  | "xai"
  | "thinkingmachines"
  | "moonshotai"
  | "nvidia"
  | "meta"
  | "amazon"
  | "tencent"
  | "xiaomi"
  | "stepfun"
  | "other";

/**
 * A model's family. OPEN by design: a closed union would mean a model
 * discovered from the catalogue could not name its own maker until someone
 * shipped a release, which is exactly the coupling the two-layer registry
 * exists to remove. `KnownModelFamily` still gets branding and a translated
 * label; anything else renders through the `other` fallback, with a deterministic
 * accent so two unfamiliar makers never look like the same one.
 *
 * The `string & {}` half keeps editor completion on the known members while
 * accepting the rest — the alternative is a cast, and this codebase does not
 * take casts.
 */
// oxlint-disable-next-line ban-types
export type ModelFamily = KnownModelFamily | (string & {});

export type CostClass = "premium" | "standard" | "budget";

/**
 * Native multimodal-input policy (chantier C5) — which attachment
 * modalities this profile receives as NATIVE content parts instead of
 * routing them through the `read`/`vision` tools.
 *
 * Integrity invariant (`model-registry.test.ts`): activation ⊆ catalog
 * facts — `image:true` ⇒ catalog lists `"image"`, `video:true` ⇒
 * `"video"`, `fileMimeTypes` non-empty ⇒ `"file"`, `audio:true` ⇒
 * `"audio"`. The catalog is the hard ceiling; this block is the product
 * decision under it. That subset rule is the ONLY invariant — there is no
 * frozen allow-list of which profiles may activate what, because a
 * registry meant to grow cannot have its capabilities pinned by a test.
 *
 * Default posture is now ACTIVE, not inert: if the model accepts a modality
 * upstream, send it natively — tool-mediated routing is the fallback for
 * what the model genuinely cannot read. The exception is `audio`, which
 * stays off everywhere: no call site produces audio parts yet, so
 * activating it would be untested surface.
 */
export interface NativeInputPolicy {
  image: boolean;
  video: boolean;
  /**
   * MIME types sent as native `file` parts (v2 — native PDF). Empty =
   * disabled. Which types an upstream truly accepts is family knowledge
   * OpenRouter does not expose; today the only candidate is
   * `application/pdf`, and only where the catalog lists `"file"`.
   */
  fileMimeTypes: readonly string[];
  audio: boolean;
}

/**
 * The native-file byte ceiling. A native file is inlined as a base64 data URL
 * and re-sent every turn — beyond this, the tool-mediated path (read/vision) is
 * objectively better.
 *
 * How MANY parts ride one request is the sibling policy, and it lives with the
 * code that applies it (`NATIVE_PARTS_PER_REQUEST` in
 * `services/native-input/prepare-model-messages.ts`). Neither is a per-model
 * fact: both used to be declared on each curated profile, identically, 35 times.
 */
export const NATIVE_FILE_MAX_BYTES = 10_000_000;

/** Product decisions about a model — ours, never synced from any API. */
export interface ModelAssessment {
  costClass: CostClass;
  /**
   * Artificial Analysis model slug, pinned to THIS profile's
   * `reasoning.defaultLevel`. AA publishes one record per effort level
   * (`gpt-5-6-luna-high`, `-xhigh`, `-max`, …) with materially different
   * numbers — Luna scores 33.3 / 38.1 / 46.1 / 49.1 / 51.2 from low to max —
   * so a name match would report whichever variant happens to share our
   * display name rather than the one we actually run.
   *
   * Replaces the old display-name matching in
   * `services/model-metrics/refresh.ts`, which silently returned no metrics
   * for any profile missing from `MODEL_DISPLAY_NAME`. Omit only when AA does
   * not cover the model at all — the fallback table then supplies the values.
   */
  aaSlug?: string;
  /**
   * The pool MEDIAN price for the transport this model routes through, USD per
   * 1 000 000 tokens, copied from the row the sync writes. Read by
   * `services/model-metrics/cost-level.ts`, which folds in the cache discount
   * and turns it into the relative `costLevel`; the raw dollar value never
   * leaves the backend.
   *
   * `cacheReadPerMTok` is the cached-input rate, absent when no endpoint quotes
   * a cheaper one.
   *
   * VERBOSITY USED TO SIT BESIDE THIS, and its removal is the one place the
   * derived registry knows less than curation did. How many output tokens a
   * model spends to finish a task is load-bearing for cost — the fleet differs
   * by ~20×, so $/MTok alone mis-ranks it by up to 8 positions — but no API
   * publishes it: AA's v2 and legacy endpoints carry no token counts (checked
   * field by field), its timing data resolves to a fixed-length probe, and the
   * per-model website figures cover a tenth of the fleet at 1.40× off with a
   * 17 % spread across hosts. Hand-curating it meant 22 models were ranked on a
   * measurement and 117 on the fleet median. Measured impact of dropping it
   * entirely: at most 4 points of 100 on `costLevel`, because the cost model
   * under-weights output by ~4× anyway (see `cost-level.ts`). It comes back
   * from Langfuse — our own turns, on the models we actually run — written to
   * the row, not typed into a file.
   */
  pricing: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
  };
  /**
   * Native multimodal-input policy (C5). Absorbs the former
   * `nativeFileMimeTypes`. Ships inert (all flags off) — see
   * `NativeInputPolicy`.
   */
  nativeInput: NativeInputPolicy;
  cache: { strategy: CacheStrategy };
  reasoning: {
    style: ReasoningStyle;
    /** Default effort level when the product runs in `auto` mode. */
    defaultLevel: ReasoningLevel;
  };
  /**
   * Routing envelope. `zdr` is READ from the endpoints rather than declared:
   * `true` only when every reachable route says so, `false` when one says it
   * does not, and absent when nothing said — "we could not check" and "checked,
   * retains nothing" are different claims and only the second may light a badge.
   */
  provider: {
    zdr?: boolean;
    /**
     * How the upstream picks WITHIN the remaining pool (`provider.sort`),
     * re-evaluated on every request from its own live measurements.
     *
     * This is the knob that makes routing ADAPTIVE, and it is the opposite of
     * `order`: a pin reroutes only when an upstream FAILS, so one that merely
     * gets slow keeps the traffic. Note the two cannot be combined — `order` is
     * consulted first, so a pool carrying both silently runs unsorted.
     *
     * The sync writes `"throughput"` (tokens/second) rather than latency, and
     * that is deliberate for an agent: a turn emits reasoning, tool calls and an
     * answer, so decode time dominates. Measured 2026-08-05 on a 4 096-token
     * generation, the spread on time-to-first-token across the pool was ~0.6 s
     * while the spread on completion was 14.9 s to 62.0 s. The TYPE stays as
     * wide as the row's, so a pool that someday carries another ordering is
     * served rather than dropped at this boundary.
     */
    sort?: RoutingSort;
    /**
     * HARD allow-list of upstream slugs (OpenRouter `provider.only`) — the
     * vetted pool `sort` is allowed to choose from.
     *
     * Reach for this when "which upstream serves this model" is a QUALITY
     * question no routing metric expresses. On `deepseek-v4-flash-0731`, ~12
     * upstreams are ZDR-reachable and most are disqualified for reasons speed
     * and price are blind to: several never populate the implicit prompt cache
     * (a miss costs ~4.6× on a Fretik turn), and several never stop reasoning.
     * A sort with no allow-list picks them happily.
     *
     * Unlike `order` this is HARD — `allow_fallbacks` cannot reopen the wider
     * pool, so an empty list is a 404 rather than a slow answer. List enough
     * upstreams to survive one being out, and rely on the role's FALLBACK MODEL
     * beyond that. Verified 2026-08-05: over 10 consecutive turns with a
     * rate-limited upstream in the pool, 0 errors reached the caller — OpenRouter
     * fails over inside the list silently.
     */
    only?: readonly string[];
    /**
     * Preferred upstream provider slug order (OpenRouter `provider.order`).
     * Set when a model is served by MULTIPLE upstreams with INDEPENDENT
     * prompt caches and we want tool-loop turns to keep hitting the same
     * (cache-capable) one — unpinned, OpenRouter load-balances and the
     * KV-cache goes cold between round-trips (observed on MiniMax M3).
     * Fallbacks stay enabled, so a listed provider being down degrades to
     * normal routing, never a hard failure. Omit for single-provider or
     * cache-less models.
     */
    order?: readonly string[];
    /**
     * Upstream slugs to EXCLUDE outright (OpenRouter `provider.ignore`).
     * `order` only states a preference — when every listed upstream is
     * down, routing falls back to the rest of the pool. Reach for this
     * when an upstream's output is WRONG rather than absent, so a
     * fallback can never silently reintroduce the defect.
     */
    ignore?: readonly string[];
    /**
     * Serving precisions the pool is filtered to, when filtering leaves anything
     * behind.
     *
     * Derived from the endpoints, not declared, and PRESENT ONLY WHEN SAFE: a
     * floor applied to a model whose every host is quantized empties the pool
     * (a 404, not a slower answer) rather than protecting it. Absent means "not
     * applicable here", never "no opinion" — see `quantizationsFor`.
     */
    quantizations?: readonly string[];
    /**
     * Omit `max_tokens` from requests for this profile. Needed when the
     * model's only ZDR-eligible upstream does not advertise the parameter:
     * `requireParameters` is literal `true`, so sending an unsupported param
     * EMPTIES the routing pool and OpenRouter answers HTTP 404 "No endpoints
     * found matching your data policy".
     *
     * Live case (probed 2026-07-26): OpenAI's ZDR endpoints are served by
     * Azure, which advertises `max_completion_tokens` and not `max_tokens`.
     * The chat path sends no `maxOutputTokens` and routes fine; the workflow
     * agent sends one and 404s. Honoured in
     * `agents/shared/agent-builder.ts`.
     */
    omitMaxTokens?: true;
  };
  /**
   * THE selection switch — the only thing standing between a team and a
   * model. `false` hides it from every picker and rejects it as a team
   * default / conversation pin. Required (not optional) so adding a profile
   * forces an explicit answer.
   *
   * Today's policy: everything costlier per turn than GPT-5.6 Luna @ xhigh is
   * `false`, because there is no billing yet to pass the cost on. Disabled
   * profiles stay VISIBLE in the picker with `disabledReason` explaining why,
   * rather than vanishing — a model a team cannot pick is still information.
   *
   * Note this gates SELECTION only. `ROLE_BINDINGS` resolves profiles
   * directly and bypasses `isSelectableForTier`, so a disabled profile can
   * still serve an internal role (e.g. `gemini-3.7-flash` →
   * `transform-fallback`).
   */
  enabled: boolean;
  /** Why `enabled: false` — drives the picker tooltip. Omit when enabled. */
  disabledReason?: "cost" | "no-zdr" | "unavailable";
}

/**
 * Eval evidence for a BINDING — that this role's default was measured before it
 * was applied.
 *
 * It sat on the profile until 2026-08-30, which put it on the wrong object. A
 * gate run does not measure a model in the abstract; it measures a model DOING
 * A JOB, against the model that held the job before it. That is a fact about
 * the pairing, and the profile could not express it: `minimax-m3` still carried
 * a stamp whose comment claimed it was the `chat` default four weeks after the
 * flip moved `chat` to `deepseek-v4-flash`, because nothing tied the evidence
 * to the decision it was evidence FOR.
 *
 * The move is also what lets the profile half of the registry become fully
 * derivable: every other `ModelAssessment` field is now read from a catalogue
 * or a price, and this one never could be — nobody publishes our eval results.
 *
 * Deliberately NOT read at runtime (that was the old flagship whitelist,
 * removed 2026-07-26): the harness has to be able to run an ungated candidate.
 * `model-registry.test.ts` is the only enforcement, and it covers exactly the
 * bindings a user's turn actually lands on.
 */
export interface EvalGate {
  status: "passed" | "failed" | "pending" | "untested";
  lastRunId?: string;
  gatedAt?: string;
}

export interface ModelProfile {
  /** Stable internal key — what DB rows (C8) and evals reference. */
  key: string;
  family: ModelFamily;
  catalog: ModelCatalogFacts;
  assessment: ModelAssessment;
}

/** Every place the service picks a model. One binding per role. */
export type ModelRole =
  | "chat"
  | "chat-fallback"
  | "workflow"
  | "dispatch-cheap"
  | "pre-extract"
  | "pre-extract-fallback"
  | "active-memory"
  | "memory-extract"
  | "memory-distill"
  | "memory-consolidate"
  | "memory-promote"
  | "compaction-summarizer"
  | "cheap-tasks"
  | "tool-repair"
  | "vision"
  | "vision-fallback"
  | "page-review"
  | "page-build"
  | "transform"
  | "transform-fallback";

/**
 * Role-level request envelope. C1 keeps these as role facts to stay
 * byte-identical with the historical per-role settings objects; C2
 * folds what can be derived from the profile (reasoning style/budget,
 * parallel flag) into the settings builder.
 *
 * - `chat`: reasoning enabled + max_tokens budget + usage accounting.
 * - `preextract`: reasoning effort minimal + throughput-sorted routing.
 * - `active-memory`: reasoning effort low.
 * - `bare`: no settings object at all (vision, compaction, cheap-tasks
 *   call sites own their per-call options).
 */
export type RoleSettingsKind =
  "chat" | "page-build" | "preextract" | "active-memory" | "recall" | "bare";

export interface RoleBinding {
  role: ModelRole;
  /** Registry key of the default profile for this role (code default — DB overrides arrive with C8). */
  profileKey: string;
  settingsKind: RoleSettingsKind;
  /** Wrap with the cache-control middleware (`wrapModelWithCache`). */
  wrapCache: boolean;
  /**
   * Proof this role's default was gated before it was applied. Present only on
   * bindings a real run covered; absent is honest for the rest.
   */
  evalGate?: EvalGate;
}
