import type { ModelFunctionKey } from "./functions";
import { MODEL_FUNCTION_KEYS } from "./functions";
import {
  blendedPricePerMTok,
  isFiniteNumber,
  MARKET_BLENDED_QUARTILES,
  median,
} from "./measures";
import type {
  AaMetrics,
  EndpointStat,
  LiveModelState,
  PricingSnapshot,
} from "./types";

/**
 * What a model is GOOD FOR, from measurements alone.
 *
 * One vocabulary answers two questions that used to be answered by different
 * code with different numbers: which tier badge a model carries, and which
 * functions a team may point at it. They have to agree — a picker offering a
 * model the sync grades as unfit for the job is worse than either behaviour on
 * its own — so both read the same signals through the same rules.
 *
 * The rule it replaces was PRICE BANDS, and the replacement is not a
 * refinement. Price is not a capability, and using it as one mis-classified the
 * fleet in both directions at once: on 2026-08-29 `zai-glm-5-3` — the best
 * intelligence index we track, 59.5, with a 997 952-token window — was graded
 * "workhorse" because it is mid-priced, while `kimi-k2-7-code-highspeed`, which
 * has NO intelligence measurement at all, was graded "flagship" because it is
 * expensive. Price now governs one thing only: whether a promoted model is
 * enabled by default (`PROMOTION_PRICE_CAPS`).
 *
 * ## Missing data is `unknown`, never `false`
 *
 * A signal nobody measured makes a verdict `unknown`, and AUTOMATIC attribution
 * refuses to grant on `unknown`. A curated tier written in TypeScript, or a
 * team's explicit choice, is never revoked by one — the asymmetry is deliberate:
 * a machine may not promote on absent evidence, and may not demote on it either.
 *
 * A rule that FAILED on a measured value outranks one that could not be
 * answered, because the two ask for different actions. "Its context is 64k and
 * the floor is 128k" is a decision; "nobody has graded it" is a gap.
 */

/**
 * The neutral facts every rule is written against. Deliberately not a live row:
 * `@fretik/ai` evaluates the same rules against a CURATED profile, whose
 * modalities and parameters come from a hand-written catalogue rather than from
 * a database column.
 */
export interface CapabilitySignals {
  /** Artificial Analysis intelligence index, within one `indexVersion`. */
  intelligence?: number;
  /** The window a request can actually use — the effective one, not the headline. */
  contextTokens?: number;
  /** Output tokens per second, median across the allowed pool. */
  tokensPerSecond?: number;
  /**
   * p50 time to the first token, ms, median across the allowed pool.
   *
   * p50 AND NOT p95, for a reason the data settled: measured 2026-08-30, the
   * p95 column is populated on 0 of the 22 published rows and the p50 column on
   * all 22. A ceiling on p95 is not a strict rule, it is a rule that always
   * answers `unknown` — which for the one function that exists to be fast would
   * have meant no model was ever eligible for it.
   */
  ttftP50Ms?: number;
  /** Blended USD per MTok, cache included (`measures.ts`). */
  blendedPricePerMTok?: number;
  /** Whether the model accepts tool definitions. */
  tools?: boolean;
  /** What the model accepts as input, as a catalogue or a profile declares it. */
  inputModalities?: readonly string[];
}

/**
 * The measured axes a rule can compare against. Exported because
 * `functionFloor` takes one and a caller reading floors back out of the rules
 * needs a name for what it is asking about.
 */
export type NumericSignal =
  | "intelligence"
  | "contextTokens"
  | "tokensPerSecond"
  | "ttftP50Ms"
  | "blendedPricePerMTok";

export type EligibilityRule =
  | { kind: "atLeast"; signal: NumericSignal; value: number }
  | { kind: "atMost"; signal: NumericSignal; value: number }
  | { kind: "below"; signal: NumericSignal; value: number }
  | { kind: "tools" }
  | { kind: "modality"; modality: string };

/**
 * `all` must hold; `any` needs one member. The two are not stylistic — `any` is
 * what lets a rule say "fast OR cheap" without ever letting price alone stand
 * in for a capability.
 */
export interface EligibilityCriteria {
  all: readonly EligibilityRule[];
  any?: readonly EligibilityRule[];
}

export type EligibilityVerdict = "eligible" | "ineligible" | "unknown";

/**
 * One requirement that was not met, as STRUCTURE rather than as prose.
 *
 * A conjunct, not a rule, because an `any` group fails as a unit: "fast OR
 * cheap" that holds neither way is ONE unmet requirement with two alternatives,
 * and reporting it as two would tell a reader they must fix both. A plain `all`
 * rule carries a single member.
 *
 * Exists so a client can render the requirement in its own words and its own
 * language. `failed` (below) is the same information already flattened to
 * English for logs and the audit CLI; this is what crosses an API boundary.
 */
export interface UnmetRequirement {
  rules: readonly EligibilityRule[];
}

export interface EligibilityResult {
  verdict: EligibilityVerdict;
  /** Rules that failed on a MEASURED value — the actionable half. */
  failed: string[];
  /** The same failures, structured for a caller that must re-word them. */
  unmet: UnmetRequirement[];
  /** Rules no signal could answer. */
  unknown: string[];
}

const OP_TEXT = { atLeast: "≥", atMost: "≤", below: "<" } as const;

export const describeRule = (rule: EligibilityRule): string => {
  if (rule.kind === "tools") return "tool calling";
  if (rule.kind === "modality") return `${rule.modality} input`;
  return `${rule.signal} ${OP_TEXT[rule.kind]} ${rule.value.toString()}`;
};

type RuleVerdict = "pass" | "fail" | "unknown";

const evaluateRule = (
  rule: EligibilityRule,
  signals: CapabilitySignals,
): RuleVerdict => {
  if (rule.kind === "tools") {
    if (signals.tools === undefined) return "unknown";
    return signals.tools ? "pass" : "fail";
  }
  if (rule.kind === "modality") {
    const modalities = signals.inputModalities;
    if (modalities === undefined) return "unknown";
    return modalities.includes(rule.modality) ? "pass" : "fail";
  }
  const measured = signals[rule.signal];
  if (!isFiniteNumber(measured)) return "unknown";
  const holds =
    rule.kind === "atLeast"
      ? measured >= rule.value
      : rule.kind === "atMost"
        ? measured <= rule.value
        : measured < rule.value;
  return holds ? "pass" : "fail";
};

export const evaluateEligibility = (
  criteria: EligibilityCriteria,
  signals: CapabilitySignals,
): EligibilityResult => {
  const failed: string[] = [];
  const unmet: UnmetRequirement[] = [];
  const unknown: string[] = [];
  for (const rule of criteria.all) {
    const verdict = evaluateRule(rule, signals);
    if (verdict === "fail") {
      failed.push(describeRule(rule));
      unmet.push({ rules: [rule] });
    } else if (verdict === "unknown") unknown.push(describeRule(rule));
  }
  const alternatives = criteria.any ?? [];
  if (alternatives.length > 0) {
    const verdicts = alternatives.map((rule) => evaluateRule(rule, signals));
    if (!verdicts.includes("pass")) {
      const text = alternatives.map(describeRule).join(" or ");
      if (verdicts.includes("unknown")) unknown.push(text);
      else {
        failed.push(text);
        // ONE requirement holding every alternative — see `UnmetRequirement`.
        unmet.push({ rules: alternatives });
      }
    }
  }
  return {
    verdict:
      failed.length > 0
        ? "ineligible"
        : unknown.length > 0
          ? "unknown"
          : "eligible",
    failed,
    unmet,
    unknown,
  };
};

const atLeast = (signal: NumericSignal, value: number): EligibilityRule => ({
  kind: "atLeast",
  signal,
  value,
});
const TOOLS: EligibilityRule = { kind: "tools" };

/**
 * The Artificial Analysis index every intelligence floor below is written
 * against, and the score at the top of it.
 *
 * This constant exists because the alternative failed in production. The floors
 * used to be absolute numbers on the 4.1 index — 45 and 30, chosen where the
 * fleet's own defaults sat. On 2026-09-07 AA published Intelligence Index v4.3
 * (Terminal-Bench upgraded to v4.0, AutomationBench-AA added, private-task
 * weight raised to 45 %) and RENUMBERED every model at once. Nothing about any
 * model changed; every grade fell, the middle of the range further than the top
 * (`zai-glm-5-3` 59.5 → 44, `deepseek-v4-flash` 51.8 → 35, `gpt-oss-120b`
 * 24.1 → 12), and a fleet that had cleared its floors the night before cleared
 * none of them the morning after.
 *
 * So a floor is now a SHARE of the top of the index rather than a raw score,
 * and re-calibrating after the next renumbering is one edit to `top` instead of
 * five edits nobody would think to make together. `AaMetrics.indexVersion` is
 * what proves the two are still talking about the same scale: the offline audit
 * compares it against `version` and reports the drift by name, so the next bump
 * is a finding rather than a collapse.
 *
 * The anchors, all read off AA's published v4.3 leaderboard on 2026-09-07:
 * Claude Fable 5.1 and GPT-6 Astra top it at 53, Claude Opus 5 at 51, the best
 * open weights (GLM-5.3, Kimi K3) at 44, GLM-5.2 at 39, DeepSeek V4 Pro at 36.
 */
export const AA_INDEX = {
  version: "4.3",
  /** The highest score any model holds on this index version. */
  top: 53,
} as const;

/** A floor as a share of the top of the index, rounded to a whole point. */
const floorAt = (share: number): number => Math.round(AA_INDEX.top * share);

/**
 * What each band of the index means, as a share of its top.
 *
 * - **`assistant`** (28 on v4.3, 53 %) — the model a team judges the product by.
 *   Every model the fleet actually chats with clears it by the rule rather than
 *   by an exemption: `gemini-3.7-flash` ~40, `deepseek-v4-flash` 35,
 *   `gpt-5.6-luna` ~34, `minimax-m3` ~29. Set at 53 % rather than at the 57 %
 *   the brief's "very good intelligence" would suggest for one reason: a floor
 *   that evicts a model a team already chose is the failure this recalibration
 *   exists to undo, and the margin belongs on that side.
 * - **`documents`** (20, 38 %) — extraction and transformation want a competent
 *   reader, not the top of the range. It keeps `gemini-3.5-flash-lite` (~22),
 *   which reads scanned pages for a living, and drops the small models that
 *   lose their format discipline on a long document.
 * - **`working`** (8, 15 %) — the "a certain intelligence" the memory and recall
 *   paths ask for. Its whole job is to separate `gpt-oss-120b` (12, which
 *   `memory-consolidate` is bound to for a measured reason) from the bottom of
 *   a market the v4.3 index pushed toward zero. Deliberately well below the
 *   first of those: this floor may not be the thing that takes a memory role's
 *   own model away from it.
 */
const INTELLIGENCE_ASSISTANT = floorAt(0.53);
const INTELLIGENCE_DOCUMENTS = floorAt(0.38);
const INTELLIGENCE_WORKING = floorAt(0.15);

/**
 * Speed floors, all read off the published fleet on 2026-08-30 rather than
 * chosen: the pool-median throughput runs p25 47.9, median 60.8, p75 73.5,
 * max 121 tok/s.
 *
 * The plan's original figures did not survive that measurement, and the way
 * they failed is worth keeping. A 50 tok/s memory floor landed EXACTLY on
 * `deepseek-v4-flash`, which measures 50.0 and serves three of the four memory
 * roles — one slow night and the fleet's own default becomes ineligible for the
 * function it is bound to. 30 sits between the runtime floor (20, below which
 * routing gives up) and the discovery floor (50, above which we adopt), so it
 * excludes models too slow to finish a batch without putting the default on a
 * knife edge.
 *
 * `TPS_CONVERSATIONAL` is the "50-60 tok/s" band a turn a person is watching
 * should decode in, minus the margin that same knife edge argues for:
 * `deepseek-v4-flash` serves `chat`, `workflow`, `pre-extract`, `transform` and
 * `compaction-summarizer` at exactly 50.0, so a floor AT 50 would put both the
 * assistant's and the documents' own default one slow night from ineligible.
 * 45 is also the fleet's measured p25, i.e. "not in the slow quarter".
 *
 * A 90 tok/s recall floor admitted exactly ONE published model, and a function
 * with one option is not a choice. 70 sits between the published median (60.8)
 * and p75 (73.5) — the fast third of the fleet — and keeps the pinned recall
 * judge (`gpt-oss-120b`, 121 tok/s, 380 ms) at nearly twice the bar.
 */
const TPS_CONVERSATIONAL = 45;
const TPS_MEMORY = 30;
const TPS_RECALL = 70;
const TPS_QUICK = 100;
/** The published fleet's p75 first-token latency. */
const TTFT_RECALL_MS = 2000;

/**
 * Price ceilings, in blended USD per MTok (`measures.ts`), and the one place
 * price is allowed to gate a CHOICE rather than a budget.
 *
 * The engine's standing position is that price is not a capability —
 * `DEFAULT_CANDIDATE_POLICY` sets no price ceiling on purpose, and what we are
 * willing to PAY is `PROMOTION_PRICE_CAPS`, a separate question with a separate
 * answer. That position holds for the functions a team runs once per turn.
 *
 * It stops holding on the VOLUME paths. `memory`, `recall` and `quick-tasks`
 * fire on every turn, in background batches and nightly crons; at that call
 * rate a model four times the price is not a dearer choice, it is a different
 * product. So those three carry a ceiling and NO OTHER FUNCTION DOES — least of
 * all `assistant`, where a price gate is the exact regression the eligibility
 * engine was built to undo (`zai-glm-5-3`, the best index we tracked, was kept
 * out of the chat by costing a middling amount). "A middling price" for the
 * assistant is a PREFERENCE, and it lives in the picker's ordering weights
 * where a preference belongs.
 *
 *  - `VOLUME` (p25, $0.13) — the market's cheap quartile. `deepseek-v4-flash`
 *    blends at $0.062 and `gpt-oss-120b` at $0.099, so both memory defaults
 *    clear it; `gemini-3.7-flash` at $0.349 does not, which is the intended
 *    answer for a model nobody should be paying to write memory with.
 *  - `BARGAIN` (half of p25, $0.065) — derived, not measured, and only ever an
 *    ALTERNATIVE to raw speed. `gpt-oss-20b`, the title generator, blends at
 *    $0.038 and decodes at 67 tok/s: too slow for the 100 tok/s rung and cheap
 *    enough that being slow does not matter.
 */
const PRICE_VOLUME = MARKET_BLENDED_QUARTILES.p25;
const PRICE_BARGAIN = Math.round(MARKET_BLENDED_QUARTILES.p25 * 500) / 1000;

/** Context floors, in tokens. */
const CTX_FLAGSHIP = 256_000;
const CTX_PAGES = 200_000;
const CTX_DOCUMENTS = 128_000;
const CTX_BULK = 100_000;

const atMost = (signal: NumericSignal, value: number): EligibilityRule => ({
  kind: "atMost",
  signal,
  value,
});

/**
 * Function rules. Each floor is the property that function would BREAK without,
 * never a general notion of quality — and the set reads as a LADDER, because
 * that is how the jobs actually differ:
 *
 * | function      | intelligence | tok/s | first token | blended $/MTok |
 * |---------------|--------------|-------|-------------|----------------|
 * | assistant     | 28           | 45    | —           | —              |
 * | documents     | 20           | 45    | —           | —              |
 * | memory        | 8            | 30    | —           | ≤ 0.13 (p25)   |
 * | recall        | 8            | 70    | ≤ 2 s       | ≤ 0.13 (p25)   |
 * | quick-tasks   | —            | fast OR very cheap | — | ≤ 0.13 (p25) |
 *
 * - `assistant` is the model a team judges the product by: the top of the
 *   intelligence range, a window big enough to hold a working session, and a
 *   decode rate a person watching a turn does not experience as stalling.
 * - `documents` trades a little of that intelligence for a smaller window:
 *   extraction, transformation and compaction run per DOCUMENT rather than per
 *   conversation. Its throughput floor is the SAME NUMBER as the assistant's
 *   and the reason is arithmetic rather than principle — `deepseek-v4-flash`
 *   serves `chat` and `pre-extract` alike at 50.0 tok/s, so 45 is the highest
 *   floor that does not evict the fleet's own default from one of its own
 *   functions. "Documents should be the faster of the two" is therefore a
 *   PREFERENCE, carried by the picker's ordering weights, not a gate.
 * - `memory` and `recall` split on the axis that matters: writing memory is
 *   background work, reading it happens on the hot path of every turn under a
 *   15 s ceiling. Hence a much higher speed floor and a LATENCY ceiling on
 *   recall alone, and the same cheap-quartile price ceiling on both — these are
 *   the paths that fire on every single turn.
 * - `quick-tasks` sits one rung below recall on every axis: no intelligence
 *   floor at all, and `fast OR very cheap` above a hard cheapness bar. Titles
 *   and tool-call repair are volume work where the only two acceptable answers
 *   are "instant" and "free".
 * - `vision` is the only HARD capability gate in the set: no image modality, no
 *   amount of quality substitutes. `pages` shares the assistant's intelligence
 *   floor with a slightly smaller window, because a page build re-reads a
 *   document set rather than a whole conversation — a page is the one artefact
 *   a team keeps and reopens, so it is worth paying for.
 *
 * Neither `vision` nor `pages` carries a speed floor, deliberately: both run as
 * a delegated background build, and the vision default measures 9 tok/s on a
 * job nobody is watching stream.
 */
export const FUNCTION_CRITERIA: Record<ModelFunctionKey, EligibilityCriteria> =
  {
    assistant: {
      all: [
        atLeast("intelligence", INTELLIGENCE_ASSISTANT),
        atLeast("contextTokens", CTX_FLAGSHIP),
        atLeast("tokensPerSecond", TPS_CONVERSATIONAL),
        TOOLS,
      ],
    },
    documents: {
      all: [
        atLeast("intelligence", INTELLIGENCE_DOCUMENTS),
        atLeast("contextTokens", CTX_DOCUMENTS),
        atLeast("tokensPerSecond", TPS_CONVERSATIONAL),
        TOOLS,
      ],
    },
    memory: {
      all: [
        atLeast("intelligence", INTELLIGENCE_WORKING),
        atLeast("tokensPerSecond", TPS_MEMORY),
        atLeast("contextTokens", CTX_BULK),
        atMost("blendedPricePerMTok", PRICE_VOLUME),
        TOOLS,
      ],
    },
    recall: {
      all: [
        atLeast("intelligence", INTELLIGENCE_WORKING),
        atLeast("tokensPerSecond", TPS_RECALL),
        atMost("ttftP50Ms", TTFT_RECALL_MS),
        atMost("blendedPricePerMTok", PRICE_VOLUME),
        TOOLS,
      ],
    },
    "quick-tasks": {
      all: [
        atLeast("contextTokens", CTX_BULK),
        atMost("blendedPricePerMTok", PRICE_VOLUME),
      ],
      any: [
        atLeast("tokensPerSecond", TPS_QUICK),
        atMost("blendedPricePerMTok", PRICE_BARGAIN),
      ],
    },
    vision: {
      all: [
        { kind: "modality", modality: "image" },
        atLeast("contextTokens", CTX_DOCUMENTS),
      ],
    },
    pages: {
      all: [
        atLeast("intelligence", INTELLIGENCE_ASSISTANT),
        atLeast("contextTokens", CTX_PAGES),
        TOOLS,
      ],
    },
  };

export const functionEligibility = (
  fn: ModelFunctionKey,
  signals: CapabilitySignals,
): EligibilityResult => evaluateEligibility(FUNCTION_CRITERIA[fn], signals);

/**
 * The floor one function sets on one numeric signal, read back off the rules.
 *
 * Derived rather than tabulated, because a second table of the same numbers is
 * how a surface ends up drawing a line the engine does not enforce: the
 * picker's plot paints the region a job accepts, and it has to be the region
 * the job actually accepts. `undefined` means the function sets no floor there,
 * which is a legitimate answer — `quick-tasks` grades no intelligence at all.
 *
 * `all` only. An `any` group is a choice between alternatives and has no single
 * threshold a reader could draw.
 */
export const functionFloor = (
  fn: ModelFunctionKey,
  signal: NumericSignal,
): number | undefined => {
  for (const rule of FUNCTION_CRITERIA[fn].all) {
    if (rule.kind === "atLeast" && rule.signal === signal) return rule.value;
  }
  return undefined;
};

/**
 * The functions a model EARNS. Only `eligible` grants — an `unknown` verdict
 * leaves the function off, which is how a model nobody has graded stops
 * collecting badges it has not been measured for. An empty list is a legitimate
 * answer and the card says so; under the price bands it was impossible, because
 * every model had a price and every price fell in some band.
 */
export const eligibleFunctions = (
  signals: CapabilitySignals,
): ModelFunctionKey[] =>
  MODEL_FUNCTION_KEYS.filter(
    (fn) => functionEligibility(fn, signals).verdict === "eligible",
  );

/** What the sync knows about a model at the moment it grades it. */
export interface SignalSources {
  aa: AaMetrics | null;
  pricing: PricingSnapshot;
  /** The effective window, already computed — never the catalogue headline. */
  contextTokens: number;
  endpoints: readonly EndpointStat[];
  /** Absent when nothing declares them; `vision` then answers `unknown`. */
  inputModalities?: readonly string[];
}

/**
 * Fold what the sync gathered into the neutral vocabulary.
 *
 * Speed comes from the pool MEDIAN rather than its best member, for the same
 * reason the price does: routing lands in the middle of the pool, so a floor
 * checked against the fastest host would pass on a model most turns experience
 * as slow. `tools` is read from the endpoints, and an empty pool yields
 * `undefined` — "we could not look", not "it cannot".
 */
export const capabilitySignals = (
  sources: SignalSources,
): CapabilitySignals => {
  const { endpoints } = sources;
  const across = (pick: (endpoint: EndpointStat) => number | undefined) =>
    median(endpoints.map(pick).filter(isFiniteNumber));
  const priced =
    sources.pricing.inputPerMTok > 0 || sources.pricing.outputPerMTok > 0
      ? blendedPricePerMTok(sources.pricing)
      : undefined;
  return {
    ...(isFiniteNumber(sources.aa?.intelligenceIndex)
      ? { intelligence: sources.aa.intelligenceIndex }
      : {}),
    ...(sources.contextTokens > 0
      ? { contextTokens: sources.contextTokens }
      : {}),
    ...(() => {
      const tps = across((endpoint) => endpoint.throughputP50);
      return tps === undefined ? {} : { tokensPerSecond: tps };
    })(),
    ...(() => {
      const ttft = across((endpoint) => endpoint.latencyP50Ms);
      return ttft === undefined ? {} : { ttftP50Ms: ttft };
    })(),
    ...(priced === undefined ? {} : { blendedPricePerMTok: priced }),
    ...(endpoints.length === 0
      ? {}
      : {
          tools: endpoints.some((endpoint) =>
            endpoint.supportedParameters.includes("tools"),
          ),
        }),
    ...(sources.inputModalities === undefined
      ? {}
      : { inputModalities: sources.inputModalities }),
  };
};

/**
 * The same fold, from a stored row.
 *
 * `inputModalities` is read from the dynamic profile and is therefore absent on
 * every hand-curated model — those have no dynamic profile at all. That is
 * correct here and incomplete elsewhere: `@fretik/ai` re-supplies them from the
 * curated catalogue before asking about `vision`, because the answer is in the
 * TypeScript profile rather than in this table.
 */
export const signalsFromLive = (live: LiveModelState): CapabilitySignals =>
  capabilitySignals({
    aa: live.aaMetrics,
    pricing: live.pricing,
    contextTokens: live.effectiveContextLength,
    endpoints: live.endpointStats,
    ...(live.dynamicProfile === null
      ? {}
      : { inputModalities: live.dynamicProfile.inputModalities }),
  });
