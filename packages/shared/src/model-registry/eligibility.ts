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

type NumericSignal =
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

export interface EligibilityResult {
  verdict: EligibilityVerdict;
  /** Rules that failed on a MEASURED value — the actionable half. */
  failed: string[];
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
  const unknown: string[] = [];
  for (const rule of criteria.all) {
    const verdict = evaluateRule(rule, signals);
    if (verdict === "fail") failed.push(describeRule(rule));
    else if (verdict === "unknown") unknown.push(describeRule(rule));
  }
  const alternatives = criteria.any ?? [];
  if (alternatives.length > 0) {
    const verdicts = alternatives.map((rule) => evaluateRule(rule, signals));
    if (!verdicts.includes("pass")) {
      const text = alternatives.map(describeRule).join(" or ");
      if (verdicts.includes("unknown")) unknown.push(text);
      else failed.push(text);
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
 * Intelligence floors, on the Artificial Analysis 4.1 index. 45 is where the
 * fleet's own flagships sit (`deepseek-v4-flash` 51.8, `gemini-3.7-flash` 56.0,
 * `gpt-5.6-luna` 50.1, `minimax-m3` 45.4 — all four clear it BY THE RULE rather
 * than by an exemption); 30 is the p25 of the published fleet.
 *
 * A floor only means something within one index version, which is why
 * `AaMetrics.indexVersion` is stored: AA renumbers the fleet on a major bump,
 * and without that column the same constant would quietly start selecting a
 * different set of models.
 */
const INTELLIGENCE_FLAGSHIP = 45;
const INTELLIGENCE_WORKHORSE = 30;

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
 * A 90 tok/s recall floor admitted exactly ONE published model. 60 — the
 * published median — admits eight, including the pinned recall judge
 * (`gpt-oss-120b`, 121 tok/s, 380 ms) with real margin. A function with one
 * option is not a choice.
 */
const TPS_MEMORY = 30;
const TPS_RECALL = 60;
const TPS_QUICK = 100;
/** The published fleet's p75 first-token latency. */
const TTFT_RECALL_MS = 2000;

/** Context floors, in tokens. */
const CTX_FLAGSHIP = 256_000;
const CTX_PAGES = 200_000;
const CTX_DOCUMENTS = 128_000;
const CTX_BULK = 100_000;

/**
 * Function rules. Each floor is the property that function would BREAK without,
 * never a general notion of quality:
 *
 * - `assistant` and `pages` need reasoning and a window big enough to hold a
 *   working session; pages sits slightly lower because a page build re-reads a
 *   document set rather than a whole conversation.
 * - `documents` needs the window (compaction runs on a nearly full one) and
 *   tools, not the top of the intelligence range.
 * - `memory` and `recall` split on the axis that matters: writing memory is
 *   background work, reading it happens on the hot path of every turn under a
 *   15 s ceiling. Hence a speed floor on both and a LATENCY ceiling on recall
 *   alone.
 * - `quick-tasks` is volume work — fast or cheap, either will do.
 * - `vision` is the only HARD capability gate in the set: no image modality, no
 *   amount of quality substitutes.
 */
export const FUNCTION_CRITERIA: Record<ModelFunctionKey, EligibilityCriteria> =
  {
    assistant: {
      all: [
        atLeast("intelligence", INTELLIGENCE_FLAGSHIP),
        atLeast("contextTokens", CTX_FLAGSHIP),
        TOOLS,
      ],
    },
    documents: {
      all: [
        atLeast("intelligence", INTELLIGENCE_WORKHORSE),
        atLeast("contextTokens", CTX_DOCUMENTS),
        TOOLS,
      ],
    },
    memory: {
      all: [
        atLeast("tokensPerSecond", TPS_MEMORY),
        atLeast("contextTokens", CTX_BULK),
        TOOLS,
      ],
    },
    recall: {
      all: [
        atLeast("tokensPerSecond", TPS_RECALL),
        { kind: "atMost", signal: "ttftP50Ms", value: TTFT_RECALL_MS },
        TOOLS,
      ],
    },
    "quick-tasks": {
      all: [atLeast("contextTokens", CTX_BULK)],
      any: [
        atLeast("tokensPerSecond", TPS_QUICK),
        {
          kind: "below",
          signal: "blendedPricePerMTok",
          value: MARKET_BLENDED_QUARTILES.p25,
        },
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
        atLeast("intelligence", INTELLIGENCE_FLAGSHIP),
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
