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
 * - **Promotion is eval-gated, never guessed.** A profile is `pending`
 *   until a C3 gate run, committed by a human, flips it to `passed`.
 *   The PR is the promotion.
 * - **Catalog facts are exact.** Modalities list what the model truly
 *   accepts upstream — product policy (e.g. which attachments go
 *   native, C5) reads these facts plus `evalGate`, it does not edit
 *   them.
 */

/** Native modality vocabulary — identical to OpenRouter's `architecture` arrays. */
export type InputModality = "text" | "image" | "file" | "audio" | "video";
export type OutputModality = "text" | "image" | "audio";

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
 * sync: 2026-06-11.
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
 * scale (`xhigh|high|medium|low|minimal`). OpenRouter normalises
 * effort across providers (translating to budgets for budget-style
 * models), so this is the portable currency; `max_tokens` is never
 * exposed as a product knob. UI mapping (C8): auto (product default)
 * + a single per-conversation « deep thinking » toggle = `high`. The
 * level → wire-param mapping is per-profile (C2) and re-baselined via
 * evals, never guessed.
 */
export type ReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "minimax"
  | "deepseek"
  | "qwen"
  | "zai"
  | "other";

export type CostClass = "premium" | "standard" | "budget";

/**
 * Product tiers a team customises (C8). `flagship` = main chat loop,
 * `workhorse` = tool-capable cheap sub-work (pre-extract, sub-agents,
 * compaction), `utility` = judgment-on-context one-shots (memory
 * recall, titles, reformulation). A profile may belong to MORE THAN ONE
 * tier — e.g. Sonnet 4.6 / Gemini 3.5 Flash serve as both flagship and
 * workhorse — see `ModelProfile.tiers`.
 */
export type ModelTier = "flagship" | "workhorse" | "utility";

/**
 * Native multimodal-input policy (chantier C5) — which attachment
 * modalities this profile receives as NATIVE content parts instead of
 * routing them through the `read`/`vision` tools. A per-modality switch
 * that is eval-gated, never inferred from the catalog: a flag is `true`
 * only once an A/B run proves native beats tool-mediated for THIS model.
 *
 * Integrity invariant (`model-registry.test.ts`): activation ⊆ catalog
 * facts — `image:true` ⇒ catalog lists `"image"`, `video:true` ⇒
 * `"video"`, `fileMimeTypes` non-empty ⇒ `"file"`, `audio:true` ⇒
 * `"audio"`. The catalog is the hard ceiling; this block is the product
 * decision under it.
 *
 * Ships INERT — every flag is `false`/empty until a gated activation PR,
 * so `prepareModelMessages` is byte-identical to `stripFilePartsForModel`.
 * v1 wires `image` + `video`; `fileMimeTypes` (native PDF, absorbs the
 * old `nativeFileMimeTypes`) and `audio` are forward-declared for v2.
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
    maxFileBytes?: number;
    maxPdfPages?: number;
  };
}

/** Product decisions about a model — ours, never synced from any API. */
export interface ModelAssessment {
  costClass: CostClass;
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
    sort?: "throughput";
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
  };
  /** Per-family system-prompt overlay key (C2). Unset = no overlay. */
  promptOverlayKey?: string;
  /**
   * Product on/off switch — whether teams may select this profile, ORTHOGONAL
   * to `evalGate` (which records whether we've TESTED it). `false` hides it
   * from every picker AND rejects it as a team default / conversation pin,
   * even when gate-passed. Use for models we've validated but choose not to
   * offer yet (cost / beta). Absent = enabled.
   */
  enabled?: boolean;
  /**
   * Promotion state. Only `passed` profiles are selectable by teams
   * (C8). Incumbents serving prod before the gate existed are
   * grandfathered as `passed` with no `lastRunId`.
   */
  evalGate: {
    status: "passed" | "failed" | "pending";
    lastRunId?: string;
    gatedAt?: string;
  };
}

export interface ModelProfile {
  /** Stable internal key — what DB rows (C8) and evals reference. */
  key: string;
  family: ModelFamily;
  /**
   * Tiers this profile may be selected for (C8 picker grouping). Usually
   * one; multi-tier models (e.g. Sonnet 4.6, Gemini 3.5 Flash) list
   * `["flagship", "workhorse"]`. The profile surfaces in every tier menu
   * it lists, gate permitting — see `isSelectableForTier`.
   */
  tiers: readonly ModelTier[];
  catalog: ModelCatalogFacts;
  assessment: ModelAssessment;
}

/** Every place the service picks a model. One binding per role. */
export type ModelRole =
  | "chat"
  | "chat-fallback"
  | "dispatch-cheap"
  | "pre-extract"
  | "pre-extract-fallback"
  | "active-memory"
  | "memory-extract"
  | "memory-distill"
  | "memory-consolidate"
  | "compaction-summarizer"
  | "cheap-tasks"
  | "vision"
  | "vision-fallback";

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
  | "chat"
  | "preextract"
  | "active-memory"
  | "recall"
  | "bare";

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
