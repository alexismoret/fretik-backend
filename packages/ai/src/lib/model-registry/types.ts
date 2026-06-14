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
 *   decisions (grades, gate status, cache strategy, reasoning
 *   envelope); it never syncs from anywhere.
 * - **No model env vars.** Role bindings below are the code defaults;
 *   per-team / per-conversation selection comes from the DB (C8).
 *   Changing a default model = a reviewed PR, not an env edit.
 * - **Grades are eval-assigned, never guessed.** `"untested"` is the
 *   honest default; the C3 promotion gate suggests grades that a human
 *   commits here. The PR is the promotion.
 * - **Catalog facts are exact.** Modalities list what the model truly
 *   accepts upstream — product policy (e.g. which attachments go
 *   native, C5) reads these facts plus `evalGate`, it does not edit
 *   them.
 */

/** Eval-assigned quality grade. `untested` until a C3 gate run says otherwise. */
export type CapabilityGrade = "A" | "B" | "C" | "untested";

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
  /**
   * `pricing`, converted to USD per MILLION tokens (OpenRouter serves
   * per-token strings — the conversion is the only transformation).
   */
  pricing: {
    prompt: number;
    completion: number;
    /** `input_cache_read` — omitted when the upstream has no cache discount. */
    inputCacheRead?: number;
  };
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
 * recall, titles, reformulation). Every family ships at least one
 * profile per tier so the C8 picker always has a same-brand option.
 */
export type ModelTier = "flagship" | "workhorse" | "utility";

/** Product decisions about a model — ours, never synced from any API. */
export interface ModelAssessment {
  costClass: CostClass;
  toolCalling: {
    grade: CapabilityGrade;
    /**
     * Parallel tool-call support. `breaks-provider-pool` encodes the
     * 2026-05-07 finding: `parallelToolCalls: true` +
     * `require_parameters: true` empties the OpenRouter provider pool
     * for MiniMax M2.7 (200 OK, empty text, no tool calls).
     */
    parallel: "supported" | "unsupported" | "breaks-provider-pool" | "untested";
    /** Provider supports strict / grammar-constrained tool schemas (C6). */
    strictSchemas: boolean;
  };
  structuredOutput: { grade: CapabilityGrade };
  instructionFollowing: CapabilityGrade;
  /**
   * MIME types we send as native `file` parts when the catalog lists
   * the `file` input modality. Which types an upstream truly accepts
   * is family knowledge OpenRouter does not expose — today that means
   * `application/pdf` everywhere `file` is listed.
   */
  nativeFileMimeTypes: readonly string[];
  cache: {
    strategy: CacheStrategy;
    /** Max `cache_control` breakpoints (explicit-breakpoints only). */
    maxBreakpoints?: number;
  };
  reasoning: {
    style: ReasoningStyle;
    /** Default effort level when the product runs in `auto` mode. */
    defaultLevel: ReasoningLevel;
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
  };
  /** Per-family system-prompt overlay key (C2). Unset = no overlay. */
  promptOverlayKey?: string;
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
  /** Recommended tier placement (intelligence-index informed, C8 picker grouping). */
  tier: ModelTier;
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
export type RoleSettingsKind = "chat" | "preextract" | "active-memory" | "bare";

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
