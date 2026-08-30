/**
 * Model registry — typed catalogue of every model the AI service can
 * serve, with their engineering-grade capabilities.
 *
 * Design rules (plan « Audit chatbot → Roadmap », chantier C1):
 *
 * - **Two layers per profile.** `catalog` mirrors the OpenRouter models
 *   API verbatim (same field semantics, camelCased) so a script can
 *   diff our facts against the live API and flag drift —
 *   `scripts/check-model-catalog.ts`. `assessment` holds OUR product
 *   decisions (gate status, cache strategy, reasoning envelope); it
 *   never syncs from anywhere.
 * - **No model env vars.** Role bindings below are the code defaults;
 *   per-team / per-conversation selection comes from the DB (C8).
 *   Changing a default model = a reviewed PR, not an env edit.
 * - **Selection is open; only the DEFAULT is eval-gated.** Any profile a
 *   team may reach is governed by `assessment.enabled` alone. Evals gate
 *   exactly one thing: binding a profile as an APPLIED DEFAULT in
 *   `ROLE_BINDINGS` for `chat` / `workflow` — enforced by
 *   `model-registry.test.ts`, not by a runtime filter. Rationale: the
 *   product is breadth (plug in any model); a model that underperforms on
 *   our tools is the team's call to swap, not a gate's call to hide.
 * - **Catalog facts are exact.** Modalities and the reasoning contract
 *   list what the model truly accepts upstream — product policy (e.g.
 *   which attachments go native, C5) reads these facts, it does not edit
 *   them.
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
 * OpenRouter `supported_parameters` values the product actually reads.
 * The catalog stores the raw list (so drift checks are exact); use
 * `supportsParameter()` instead of `.includes()` at call sites.
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
   * - `defaultEffort`: upstream's own default, for reference.
   *
   * Being catalog (not assessment) makes steerability DERIVABLE — see
   * `selectableReasoningLevels` (resolve.ts) — instead of a hand-kept key
   * list that rots.
   * Omitted entirely when the model has no reasoning support at all.
   */
  reasoning?: {
    mandatory: boolean;
    supportedEfforts?: readonly ReasoningLevel[];
    defaultEffort?: ReasoningLevel;
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
  /**
   * HARD provider limits (facts, not heuristics) — used to bound how many
   * media parts ride a single request. `prepareModelMessages` keeps the N
   * most-recent native parts per modality and falls the older ones back to
   * tool-mediated. `maxVideosPerRequest` defaults to 1 at activation: video
   * is heavy.
   */
  limits?: {
    maxImagesPerRequest?: number;
    maxVideosPerRequest?: number;
    /** Files are heavy (inlined as data URLs) — default 2 at activation. */
    maxFilesPerRequest?: number;
    maxFileBytes?: number;
    maxPdfPages?: number;
  };
}

/**
 * Single source for the native-file byte ceiling: the value profiles set
 * as `limits.maxFileBytes` at C5v2 activation AND the fallback
 * `prepareModelMessages` applies when a profile omits it. A native file
 * is inlined as a base64 data URL and re-sent every turn — beyond this,
 * the tool-mediated path (read/vision) is objectively better.
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
   * VERBOSITY — how many output tokens this model spends to finish a task, and
   * how that splits between reasoning and answer. Hand-curated from Artificial
   * Analysis (`intelligenceIndexOutputTokensPerTask`) when a model is added.
   *
   * Load-bearing for cost, and the reason headline pricing lies: models differ
   * by ~20× in output volume, so $/MTok alone mis-ranks the fleet by up to 8
   * positions. GLM-5.2 emits 42.8k tokens per AA task at a 6.0 reasoning:answer
   * ratio; GPT-5.6 Luna @xhigh emits 12.5k at 2.1. Read by
   * `services/model-metrics/cost-level.ts`.
   *
   * NOT fetched live: AA's v2 API has no verbosity field (it exists only in the
   * website payload), so scraping it at runtime would put a layout change on
   * the request path. Refresh by hand alongside the profile.
   */
  verbosity?: {
    outputTokensPerTask: number;
    reasoningToAnswerRatio: number;
  };
  /**
   * HAND-CURATED price, USD per 1,000,000 tokens. Lives here (not in
   * `catalog`) because it is a product-maintained value, NOT the mechanical
   * OpenRouter mirror — fix it by hand, no automatic price feed. The only
   * reader is `services/model-metrics/cost-level.ts`, which folds in the cache
   * discount (weighted by `cache.strategy`) and turns it into the relative
   * `costLevel`; the raw dollar value never leaves the backend.
   *
   * `cacheReadPerMTok` is the cached-input price — omit when the model has no
   * cache discount (`cache.strategy === "none"` or no cheaper cached rate).
   * Cache WRITE has no field: OpenRouter doesn't expose it and the cost model
   * absorbs it approximately via the per-strategy cache-hit ratio.
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
  cache: {
    strategy: CacheStrategy;
    /** Max `cache_control` breakpoints (explicit-breakpoints only). */
    maxBreakpoints?: number;
  };
  reasoning: {
    style: ReasoningStyle;
    /** Default effort level when the product runs in `auto` mode. */
    defaultLevel: ReasoningLevel;
    /**
     * Per-profile hard `max_tokens` reasoning budget, overriding the
     * shared level→budget table. Only meaningful for `style:
     * "max-tokens"`. Use for ADAPTIVE models (MiniMax / DeepSeek) that
     * ignore the effort knob and over-think — pin an explicit ceiling
     * here instead of inheriting the shared per-level budget. Omit to
     * use the table value for `defaultLevel`.
     */
    maxTokens?: number;
    /**
     * `false` = strip this model's own reasoning parts from the messages
     * sent at every step of the IN-TURN tool loop
     * (`withReasoningReplayStrip`, agent-builder.ts).
     *
     * SCOPE — read this before reasoning about the flag. Cross-turn
     * reasoning is ALREADY stripped for every profile, unconditionally,
     * one layer up: `stripReasoningPartsForModel` runs on the persisted
     * history inside `prepareModelMessages` (the mandatory path). So this
     * flag governs exactly one thing — whether the loop replays the
     * reasoning IT generated earlier in the SAME turn. The name is a
     * historical misnomer; it is not about "history".
     *
     * Anthropic and Google must keep the in-turn replay: their thinking
     * blocks carry signatures that are fresh and valid within a turn, and
     * their APIs require the blocks be echoed back alongside tool results.
     *
     * Set to `false` only on measured evidence. The one profile carrying
     * it (MiniMax M3) was set from a n=5 replay of prod zombie
     * gen-1784805816 (replayed 4/5 tool calls vs stripped 5/5) — a
     * one-case delta that a controlled n=20 A/B on 2026-08-02 did NOT
     * reproduce (20/20 tool calls in BOTH arms, for M3 and DeepSeek, on
     * both a short and a long multi-step loop). It is kept on M3 for its
     * second, independent benefit: stripping removes the ×2+ per-turn
     * context inflation. Do not copy it onto a new profile as a
     * precaution — measure, or leave it absent.
     */
    replayInHistory?: false;
  };
  /**
   * OpenRouter routing envelope. `requireParameters` is non-negotiable
   * (silent `tools` drops break SSE parsing) — typed as literal `true`
   * so a profile cannot opt out. `zdr` is the DEFAULT policy but a
   * per-profile fact: a model served only by its first-party,
   * non-ZDR-flagged provider (e.g. MiniMax M3 pre-open-weights, gate
   * 2026-06-12: empty ZDR pool → 100% errors) may set `false` —
   * a deliberate product decision recorded next to the profile, to be
   * revisited when ZDR endpoints appear.
   */
  provider: {
    requireParameters: true;
    zdr?: boolean;
    /**
     * How OpenRouter picks WITHIN the remaining pool (`provider.sort`),
     * re-evaluated on every request from its own live measurements.
     *
     * This is the knob that makes routing ADAPTIVE, and it is the opposite of
     * `order`: a pin reroutes only when an upstream FAILS, so one that merely
     * gets slow keeps the traffic. Note the two cannot be combined — `order` is
     * consulted first, so a profile carrying both silently runs unsorted.
     *
     * `"throughput"` (tokens/second) rather than latency is deliberate for an
     * agent: a turn emits reasoning, tool calls and an answer, so decode time
     * dominates. Measured 2026-08-05 on a 4 096-token generation, the spread on
     * time-to-first-token across the pool was ~0.6 s while the spread on
     * completion was 14.9 s to 62.0 s.
     */
    sort?: "throughput";
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
  /** Per-family system-prompt overlay key (C2). Unset = no overlay. */
  promptOverlayKey?: string;
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
  /**
   * Eval evidence that this profile is fit to be an APPLIED DEFAULT — i.e. to
   * appear in `ROLE_BINDINGS` for `chat` / `workflow`. Enforced by
   * `model-registry.test.ts`, so swapping the default without a gate run
   * fails CI, while merely offering a model needs nothing here.
   *
   * Deliberately NOT read at runtime (that was the old flagship whitelist,
   * removed 2026-07-26) and optional: most profiles are simply `untested`,
   * which is a fine state for a selectable model.
   */
  evalGate?: {
    status: "passed" | "failed" | "pending" | "untested";
    lastRunId?: string;
    gatedAt?: string;
  };
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
}

/** Type-safe lookup over `catalog.supportedParameters`. */
export const supportsParameter = (
  profile: ModelProfile,
  parameter: SupportedParameter,
): boolean => profile.catalog.supportedParameters.includes(parameter);
