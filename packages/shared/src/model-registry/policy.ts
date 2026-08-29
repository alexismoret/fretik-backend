/**
 * The conditions a model has to meet, written once and evaluated mechanically.
 *
 * These used to live in a person's head and in prose scattered across profile
 * comments — "intelligent enough", "at least 60-70 tok/s", "ZDR", "not too
 * expensive", "good tool calling", "caches". Every one of them is a number
 * somewhere in a catalogue API, so every one of them is a rule here, evaluated
 * nightly against live data and recorded with the value that decided it.
 *
 * Two severities, and the difference is what the engine is allowed to do:
 *
 * - **hard** — the model cannot serve. It gates candidate discovery outright,
 *   and on a published model it can (after a streak, and never for a model an
 *   internal role depends on) flip `enabled` to false.
 * - **soft** — the model works but is worse than we want. It feeds the health
 *   score and the alerts, and it never disables anything on its own.
 *
 * Every rule is a pure function of the signals passed in. Nothing here reads a
 * clock, a database or the network: the sync gathers, this decides, the caller
 * writes.
 */
import type {
  AaMetrics,
  EndpointStat,
  PolicyReport,
  PolicyRuleResult,
} from "./types";

export interface ModelPolicy {
  /** Refuse a model with no zero-retention route. */
  zdrRequired: boolean;
  /**
   * Floor on the FASTEST endpoint's median decode, not on the pool average:
   * routing sorts by throughput, so the pool's ceiling is what a turn actually
   * gets. Tokens per second.
   */
  minTpsP50?: number;
  /** Ceiling on the best endpoint's p95 time-to-first-token, milliseconds. */
  maxTtftP95Ms?: number;
  /** USD per 1,000,000 tokens, compared against the pool median. */
  maxPricePerMTok?: { input?: number; output?: number };
  minContextLength?: number;
  minMaxOutput?: number;
  /** Every allowed endpoint must advertise `tools`. */
  toolCallingRequired: boolean;
  /** At least one endpoint must cache prompts implicitly. */
  cachingRequired?: boolean;
  /** Floor on `uptime_last_1d` of the best endpoint, percent. */
  minUptime1d?: number;
  /** Floor on the Artificial Analysis intelligence index, when we have one. */
  minIntelligenceIndex?: number;
  /** Serving precisions accepted when a source reports one. */
  quantizationFloor?: readonly string[];
}

/**
 * Discovery policy — deliberately strict. It decides which of the several
 * hundred models in a gateway catalogue are worth a human's attention, so a
 * false positive costs an operator a look and a false negative costs nothing
 * (the model can still be added by name with `model-admin add`).
 */
export const DEFAULT_CANDIDATE_POLICY: ModelPolicy = {
  zdrRequired: true,
  minTpsP50: 60,
  maxTtftP95Ms: 8_000,
  maxPricePerMTok: { input: 2, output: 8 },
  minContextLength: 128_000,
  minMaxOutput: 8_000,
  toolCallingRequired: true,
  cachingRequired: true,
  minUptime1d: 98,
  minIntelligenceIndex: 30,
  // NO quantization floor, deliberately. This codebase has emptied a pool with
  // one before (160/160 calls refused, 2026-08-03) and learned the lesson
  // written in the memory-utility builder: quantization was standing in for
  // "this small model loses its format discipline", which is a fact about one
  // model rather than about fp4. Measured again on 2026-08-29, every host of
  // deepseek-v3.1 serves fp4 or fp8 — a `bf16` floor would reject the model
  // outright. Set it per policy where a specific model has earned it.
};

/**
 * Health policy for models already in the fleet — same rules, looser numbers.
 * A published model was chosen deliberately and may be kept for a reason no
 * metric sees (the fallback model exists to be a DIFFERENT family, not a fast
 * one), so this policy answers "is it still serviceable", not "would we pick it
 * again".
 *
 * The throughput floor is far below the discovery one ON PURPOSE, and the gap
 * is the whole design. Speed is a REASON TO ADOPT a model and a poor reason to
 * refuse a request: routing is ordered by throughput, so a slower host is only
 * ever reached when every faster one is unavailable — precisely when serving
 * slowly beats not serving. Measured 2026-08-29 across the 109 endpoints of
 * the published fleet (p10 = 23 tps, p50 = 72), the discovery floor applied at
 * runtime would leave `gpt-5.4-nano`, `gpt-5.6-sol` and `gpt-5.6-luna` with NO
 * endpoint at all. What is left here is not a quality bar but the line below
 * which a streamed turn reads as broken rather than slow.
 */
export const PUBLISHED_POLICY: ModelPolicy = {
  zdrRequired: true,
  minTpsP50: 20,
  maxPricePerMTok: { input: 10, output: 40 },
  minContextLength: 100_000,
  toolCallingRequired: true,
  minUptime1d: 90,
};

export interface PolicySignals {
  /** Endpoints left after pool filtering and quarantine — what a call can hit. */
  endpoints: EndpointStat[];
  /** Providers dropped while building that pool, with the reason. */
  excludedProviders: { provider: string; reason: string }[];
  aa?: AaMetrics | null;
  /**
   * Result of an actual zero-retention request. Neither catalogue API exposes
   * ZDR eligibility, and the gateway only answers by refusing the call, so the
   * only honest signal is to have made one. Absent = unverified, which is a
   * soft failure rather than a hard one.
   */
  zdrProbe?: { ok: boolean; at: string };
  /** The model serves a tool-calling role, so `tools` support is mandatory. */
  requiresTools: boolean;
  /** Explicit cache markers are placed by us; implicit caching is not required. */
  usesExplicitCaching?: boolean;
}

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (upper === undefined) return undefined;
  return sorted.length % 2 === 0 && lower !== undefined
    ? (lower + upper) / 2
    : upper;
};

const definedNumbers = (
  endpoints: EndpointStat[],
  pick: (e: EndpointStat) => number | undefined,
): number[] => {
  const out: number[] = [];
  for (const endpoint of endpoints) {
    const value = pick(endpoint);
    if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  }
  return out;
};

const rule = (
  name: string,
  severity: "hard" | "soft",
  passed: boolean,
  detail: string,
): PolicyRuleResult => ({ rule: name, severity, passed, detail });

/**
 * Grade one model against one policy. The report lists every rule that was
 * EVALUATED — a rule the policy does not set, or that no source could answer,
 * is absent rather than silently passing, so "we did not check" never reads as
 * "it is fine".
 */
export const evaluatePolicy = (
  policy: ModelPolicy,
  signals: PolicySignals,
  now: Date,
): PolicyReport => {
  const rules: PolicyRuleResult[] = [];
  const { endpoints } = signals;

  rules.push(
    rule(
      "pool-non-empty",
      "hard",
      endpoints.length > 0,
      endpoints.length > 0
        ? `${endpoints.length.toString()} endpoint(s) reachable`
        : "no endpoint left after pool filtering and quarantine",
    ),
  );

  if (policy.zdrRequired) {
    // Answered from the catalogue first. The gateway publishes `has_zdr` per
    // endpoint, so a model with at least one zero-retention host is a fact we
    // can read every night for free — the probe is confirmation, not the
    // source. Under the previous transport it WAS the source: nothing exposed
    // eligibility, so it had to be discovered by making a call and reading back
    // which host answered.
    //
    // `null` means the gateway has no established stance for that host, not
    // that the host retains. It neither passes nor fails the rule: routing
    // still carries `zeroDataRetention: true`, which filters at request time.
    const known = endpoints.filter((e) => e.hasZdr !== undefined);
    const zdrHosts = endpoints.filter((e) => e.hasZdr === true);
    if (zdrHosts.length > 0) {
      // A row is a ROUTE, not a company, and one company can serve several:
      // measured 2026-08-29, xAI serves grok-4.5 as both `xai/zdr` and
      // `xai/zdr/priority`, Fireworks serves glm-5.2 under three. Counting
      // routes while listing providers produced `2 endpoint(s): xai, xai` and
      // a list with `fireworks` three times — a reader counts hosts and gets a
      // number no host list supports. Both figures are worth saying; neither
      // may wear the other's name.
      const hosts = [...new Set(zdrHosts.map((e) => e.provider))];
      rules.push(
        rule(
          "zdr",
          "hard",
          true,
          `${zdrHosts.length.toString()} zero-retention route(s) across ${hosts.length.toString()} host(s): ${hosts.join(", ")}`,
        ),
      );
    } else if (known.length > 0) {
      rules.push(
        rule(
          "zdr",
          "hard",
          false,
          `no endpoint in the pool declares zero retention (${known.length.toString()} checked)`,
        ),
      );
    } else if (signals.zdrProbe !== undefined) {
      rules.push(
        rule(
          "zdr",
          "hard",
          signals.zdrProbe.ok,
          signals.zdrProbe.ok
            ? `zero-retention request accepted (${signals.zdrProbe.at})`
            : `zero-retention request refused (${signals.zdrProbe.at})`,
        ),
      );
    } else {
      // Three states, not two, and saying which one this is matters: a model
      // whose hosts have simply not been graded is in a different position from
      // one with no endpoints at all. First-party hosts are the common case —
      // measured 2026-08-29, the gateway reports `null` for Google, Mistral,
      // xAI and MiniMax serving their own models. Routing still carries the
      // zero-retention flag, so the request is filtered upstream either way.
      rules.push(
        rule(
          "zdr",
          "soft",
          false,
          endpoints.length > 0
            ? `${endpoints.length.toString()} endpoint(s), none declaring a retention stance — enforced at request time, not verifiable from the catalogue`
            : "no endpoint data and no probe on record",
        ),
      );
    }
  }

  if (policy.minContextLength !== undefined && endpoints.length > 0) {
    const contexts = definedNumbers(endpoints, (e) => e.contextLength);
    const worst = contexts.length > 0 ? Math.min(...contexts) : 0;
    rules.push(
      rule(
        "context-floor",
        "hard",
        worst >= policy.minContextLength,
        `smallest endpoint context ${worst.toString()} vs floor ${policy.minContextLength.toString()}`,
      ),
    );
  }

  if (policy.minMaxOutput !== undefined && endpoints.length > 0) {
    const caps = definedNumbers(endpoints, (e) => e.maxCompletionTokens);
    const worst = caps.length > 0 ? Math.min(...caps) : undefined;
    if (worst !== undefined) {
      rules.push(
        rule(
          "max-output-floor",
          "soft",
          worst >= policy.minMaxOutput,
          `smallest endpoint output cap ${worst.toString()} vs floor ${policy.minMaxOutput.toString()}`,
        ),
      );
    }
  }

  if (policy.toolCallingRequired && signals.requiresTools) {
    const without = endpoints.filter(
      (e) => !e.supportedParameters.includes("tools"),
    );
    rules.push(
      rule(
        "tool-calling",
        "hard",
        without.length === 0 && endpoints.length > 0,
        without.length === 0
          ? "every reachable endpoint advertises `tools`"
          : `endpoints without \`tools\`: ${without.map((e) => e.provider).join(", ")}`,
      ),
    );
  }

  if (policy.minTpsP50 !== undefined) {
    // The pool ceiling, not its average: routing sorts by throughput, so the
    // fastest member is the one a turn lands on.
    const speeds = definedNumbers(endpoints, (e) => e.throughputP50);
    if (speeds.length > 0) {
      const best = Math.max(...speeds);
      rules.push(
        rule(
          "throughput-floor",
          "soft",
          best >= policy.minTpsP50,
          `fastest endpoint ${best.toFixed(0)} tok/s vs floor ${policy.minTpsP50.toString()}`,
        ),
      );
    }
  }

  if (policy.maxTtftP95Ms !== undefined) {
    const latencies = definedNumbers(endpoints, (e) => e.latencyP95Ms);
    if (latencies.length > 0) {
      const best = Math.min(...latencies);
      rules.push(
        rule(
          "ttft-ceiling",
          "soft",
          best <= policy.maxTtftP95Ms,
          `best endpoint p95 TTFT ${best.toFixed(0)} ms vs ceiling ${policy.maxTtftP95Ms.toString()} ms`,
        ),
      );
    }
  }

  if (policy.maxPricePerMTok !== undefined && endpoints.length > 0) {
    const inputMedian = median(
      definedNumbers(endpoints, (e) => e.pricing.inputPerMTok),
    );
    const outputMedian = median(
      definedNumbers(endpoints, (e) => e.pricing.outputPerMTok),
    );
    const { input, output } = policy.maxPricePerMTok;
    if (input !== undefined && inputMedian !== undefined) {
      rules.push(
        rule(
          "price-input-ceiling",
          "hard",
          inputMedian <= input,
          `pool median input $${inputMedian.toFixed(3)}/MTok vs ceiling $${input.toString()}`,
        ),
      );
    }
    if (output !== undefined && outputMedian !== undefined) {
      rules.push(
        rule(
          "price-output-ceiling",
          "hard",
          outputMedian <= output,
          `pool median output $${outputMedian.toFixed(3)}/MTok vs ceiling $${output.toString()}`,
        ),
      );
    }
  }

  if (policy.minUptime1d !== undefined) {
    const uptimes = definedNumbers(endpoints, (e) => e.uptime1d);
    if (uptimes.length > 0) {
      const best = Math.max(...uptimes);
      rules.push(
        rule(
          "uptime-floor",
          "soft",
          best >= policy.minUptime1d,
          `best endpoint 1d uptime ${best.toFixed(2)}% vs floor ${policy.minUptime1d.toString()}%`,
        ),
      );
    }
  }

  if (policy.cachingRequired === true && signals.usesExplicitCaching !== true) {
    const caching = endpoints.filter((e) => e.supportsImplicitCaching === true);
    rules.push(
      rule(
        "caching",
        "soft",
        caching.length > 0,
        caching.length > 0
          ? `${caching.length.toString()} endpoint(s) cache implicitly`
          : "no endpoint reports implicit caching",
      ),
    );
  }

  if (policy.minIntelligenceIndex !== undefined) {
    const index = signals.aa?.intelligenceIndex;
    if (index !== undefined) {
      rules.push(
        rule(
          "intelligence-floor",
          "soft",
          index >= policy.minIntelligenceIndex,
          `Artificial Analysis intelligence ${index.toFixed(1)} vs floor ${policy.minIntelligenceIndex.toString()}`,
        ),
      );
    }
  }

  const hardFailures = rules.filter(
    (r) => r.severity === "hard" && !r.passed,
  ).length;
  const softFailures = rules.filter(
    (r) => r.severity === "soft" && !r.passed,
  ).length;

  return {
    passed: hardFailures === 0,
    hardFailures,
    softFailures,
    rules,
    evaluatedAt: now.toISOString(),
    excludedProviders: signals.excludedProviders,
  };
};

/**
 * Composite 0-100 health for a published model. Uptime dominates because an
 * endpoint that answers slowly still answers; the policy term captures
 * everything else the rules measured, and recent incidents are the only input
 * that comes from our own traffic rather than a vendor's dashboard.
 */
export const computeHealthScore = (input: {
  endpoints: EndpointStat[];
  report: PolicyReport | null;
  incidents24h: number;
}): number => {
  const { endpoints, report, incidents24h } = input;
  if (endpoints.length === 0) return 0;

  const uptimes = definedNumbers(endpoints, (e) => e.uptime1d);
  // No traffic reported is not evidence of failure — grade it neutral rather
  // than perfect, so an idle endpoint cannot carry a pool's score.
  const uptimeTerm = uptimes.length > 0 ? Math.max(...uptimes) : 95;

  const softPenalty = report ? Math.min(report.softFailures, 4) * 5 : 0;
  const hardPenalty = report ? Math.min(report.hardFailures, 3) * 20 : 0;
  const incidentPenalty = Math.min(incidents24h, 10) * 3;

  const score = uptimeTerm - softPenalty - hardPenalty - incidentPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
};

/** Health bands. `unknown` is for a model the sync has never graded. */
export const healthFromScore = (
  score: number,
): "healthy" | "degraded" | "failing" => {
  if (score >= 85) return "healthy";
  if (score >= 60) return "degraded";
  return "failing";
};
