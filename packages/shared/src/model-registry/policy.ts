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
  PolicyRuleSkipReason,
  PricingSnapshot,
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
 * Discovery policy — strict on CAPABILITY, silent on price. It decides which of
 * the several hundred models in a gateway catalogue are worth a human's
 * attention, so a false positive costs an operator a look and a false negative
 * costs nothing (the model can still be added by name with `model-admin add`).
 *
 * NO PRICE CEILING, deliberately (2026-08-30). Price is not a property of a
 * model's fitness, it is a property of who pays: once teams spend their own
 * credits, an expensive model is a choice they are entitled to make, and a
 * catalogue that never surfaced it would be hiding the option rather than
 * offering it. Until then the money is still ours, so price decides `enabled`
 * at promotion time and every night after — see `PROMOTION_PRICE_CAPS` — which
 * keeps the bill bounded without pretending an expensive model is a bad one.
 *
 * The throughput floor is an ADOPTION bar, at 50 rather than 60 since
 * 2026-08-30: a model whose best host cannot decode at 50 tps today is not one
 * to build on, but the band from 50 to 60 held real candidates (four on
 * 2026-08-29, best-endpoint p50 between 50.5 and 59.0) that no other rule
 * objected to.
 */
export const DEFAULT_CANDIDATE_POLICY: ModelPolicy = {
  zdrRequired: true,
  minTpsP50: 50,
  maxTtftP95Ms: 8_000,
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

/**
 * What we are willing to PAY FOR, as opposed to what we are willing to offer.
 *
 * USD per 1,000,000 tokens, compared against the pool median. These are the
 * ceilings discovery used to enforce; moving them here separates two questions
 * that were tangled: "is this model any good" (capability, decided by
 * `DEFAULT_CANDIDATE_POLICY`) and "are we paying for it today" (this). A model
 * above the caps is still discovered, still promoted, still visible — it simply
 * arrives `enabled: false, disabledReason: "cost"` and an operator can turn it
 * on deliberately. When teams spend their own credits, this whole gate is what
 * gets replaced by a balance check.
 */
export const PROMOTION_PRICE_CAPS = {
  inputPerMTok: 2,
  outputPerMTok: 8,
} as const;

/**
 * Whether a model's measured price lets it run on our budget. Pure, so the
 * promote path and the nightly re-check cannot drift apart.
 *
 * BOTH caps must hold: a cheap prompt does not pay for an expensive completion,
 * and our turns are heavy on both. Equality passes — a cap is a limit, not an
 * exclusive bound.
 *
 * Re-evaluated on EVERY sync, not only at promotion (2026-08-30). Prices move:
 * upstreams reprice, run promotions, and change tiers. Checking once at
 * promotion would mean a model promoted at $1.90 that later rose to $3 stayed
 * enabled forever, while an identical model discovered the next day would be
 * promoted disabled — the same fleet, two different answers, decided by nothing
 * but arrival order.
 */
export const promotionEnablement = (
  pricing: PricingSnapshot,
): { enabled: boolean; disabledReason?: "cost" } =>
  pricing.inputPerMTok <= PROMOTION_PRICE_CAPS.inputPerMTok &&
  pricing.outputPerMTok <= PROMOTION_PRICE_CAPS.outputPerMTok
    ? { enabled: true }
    : { enabled: false, disabledReason: "cost" };

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
  /**
   * What the catalogues consulted for this pool can EVER publish (ORed across
   * the transports actually fetched). Decides the reason on a skipped rule:
   * a family the sources publish but did not return is `not-measured`; one no
   * consulted source can return is `not-published-by-source`. Absent = unknown,
   * which reads as `not-measured` — the repairable reading, so a wiring gap is
   * investigated rather than shrugged off as structural.
   */
  sourcePublishes?: {
    percentiles?: boolean;
    toolChoice?: boolean;
    uptime?: boolean;
  };
  /**
   * What OUR OWN traffic measured for each upstream, keyed by normalised
   * provider name. Preferred over the catalogue's figures wherever it has an
   * entry — the caller is responsible for only passing upstreams with enough
   * observations to mean something.
   *
   * This is the point of collecting it. A catalogue publishes a throughput
   * aggregated over everybody's traffic on routes we may not use, measured
   * from somewhere else, and it goes blank the moment a credential lapses. A
   * figure from our own calls describes the service WE get, and it cannot be
   * turned off by an API key.
   */
  measured?: ReadonlyMap<
    string,
    { throughputP50?: number; latencyP50Ms?: number }
  >;
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

const skippedRule = (
  name: string,
  severity: "hard" | "soft",
  skipped: PolicyRuleSkipReason,
  detail: string,
): PolicyRuleResult => ({
  rule: name,
  severity,
  passed: false,
  skipped,
  detail,
});

/**
 * The skip reason for a measurement family, given what the consulted sources
 * declare. Unknown reads as `not-measured` — the repairable reading.
 */
const skipReasonFor = (publishes: boolean | undefined): PolicyRuleSkipReason =>
  publishes === false ? "not-published-by-source" : "not-measured";

/** What our own traffic said about this endpoint's host, if anything. */
const measuredFor = (
  signals: PolicySignals,
  endpoint: EndpointStat,
): { throughputP50?: number; latencyP50Ms?: number } =>
  signals.measured?.get(endpoint.provider) ?? {};

/**
 * A short suffix naming where the graded figures came from, appended to the
 * rule's detail.
 *
 * Worth the characters because the two sources can disagree by a lot and the
 * reader's next move depends on which one spoke: a slow figure we measured is
 * a host to reconsider, the same figure from a catalogue may be describing
 * routes we never touch. Silent when nothing was measured — the catalogue is
 * the assumed source and saying so on every line would be noise.
 */
const provenance = (
  signals: PolicySignals,
  endpoints: EndpointStat[],
  field: "throughputP50" | "latencyP50Ms",
): string => {
  const ours = endpoints.filter(
    (endpoint) => measuredFor(signals, endpoint)[field] !== undefined,
  ).length;
  if (ours === 0) return "";
  return ours === endpoints.length
    ? " (measured on our own traffic)"
    : ` (${ours.toString()} of ${endpoints.length.toString()} measured on our own traffic, the rest as published)`;
};

/**
 * Grade one model against one policy. The report lists every rule the policy
 * SETS — evaluated when the data arrived, `skipped` when it did not. A rule
 * the policy does not set is absent; a rule it sets is never absent, because
 * for months the unanswerable rules simply vanished and "we did not check"
 * rendered exactly like "everything passed" — the throughput floor whose
 * docstring argues hardest for its number had never run once on the fleet.
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

  if (policy.minContextLength !== undefined) {
    if (endpoints.length > 0) {
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
    } else {
      rules.push(
        skippedRule(
          "context-floor",
          "hard",
          "not-measured",
          "no endpoint to grade",
        ),
      );
    }
  }

  if (policy.minMaxOutput !== undefined) {
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
    } else {
      rules.push(
        skippedRule(
          "max-output-floor",
          "soft",
          "not-measured",
          endpoints.length > 0
            ? "no endpoint reports an output cap"
            : "no endpoint to grade",
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

    // A separate, SOFTER question: accepting tool definitions is not the same
    // as accepting to be forced onto one. Two paths depend on forcing — the
    // schema-guided extract engine and the tool-call repair one-shot — and a
    // host missing `required` does not error there, it answers in prose, which
    // surfaces as a parse failure blamed on the model. Soft because most turns
    // never force, and because only one source reports the field at all: graded
    // only where at least one endpoint answered, so silence is never a verdict.
    const answering = endpoints.filter(
      (e) => e.supportsToolChoice !== undefined,
    );
    if (answering.length > 0) {
      const forcing = answering.filter((e) =>
        e.supportsToolChoice?.includes("required"),
      );
      rules.push(
        rule(
          "tool-choice",
          "soft",
          forcing.length > 0,
          forcing.length > 0
            ? `${forcing.length.toString()} of ${answering.length.toString()} reporting endpoint(s) accept a forced tool call`
            : `no reporting endpoint accepts \`tool_choice: required\` — forced extraction would answer in prose instead`,
        ),
      );
    } else {
      rules.push(
        skippedRule(
          "tool-choice",
          "soft",
          skipReasonFor(signals.sourcePublishes?.toolChoice),
          "no endpoint reports its accepted `tool_choice` modes",
        ),
      );
    }
  }

  if (policy.minTpsP50 !== undefined) {
    // The pool ceiling, not its average: routing sorts by throughput, so the
    // fastest member is the one a turn lands on.
    //
    // MEASURED BEATS DECLARED, per endpoint. A host we have called thousands
    // of times is described better by those calls than by a figure its vendor
    // aggregated over everybody's traffic — and unlike that figure, ours
    // cannot vanish because a key lapsed.
    const speeds = definedNumbers(
      endpoints,
      (e) => measuredFor(signals, e).throughputP50 ?? e.throughputP50,
    );
    if (speeds.length > 0) {
      const best = Math.max(...speeds);
      rules.push(
        rule(
          "throughput-floor",
          "soft",
          best >= policy.minTpsP50,
          `fastest endpoint ${best.toFixed(0)} tok/s vs floor ${policy.minTpsP50.toString()}${provenance(signals, endpoints, "throughputP50")}`,
        ),
      );
    } else {
      rules.push(
        skippedRule(
          "throughput-floor",
          "soft",
          skipReasonFor(signals.sourcePublishes?.percentiles),
          "no endpoint carries a throughput figure",
        ),
      );
    }
  }

  if (policy.maxTtftP95Ms !== undefined) {
    // p95 where a source reports one; OpenRouter's percentile objects carry
    // p90 instead, kept in its own field so it is never PRESENTED as a p95.
    // For a ceiling it is the slightly lenient neighbour — a p90 under the bar
    // says less than a p95 under it — which the detail names so a reader can
    // weigh the evidence rather than trust a number wearing the wrong label.
    //
    // Our own measurement outranks both, and this is the rule where that
    // matters most: a catalogue times the first token of ANY kind, from its
    // own vantage point, so for a reasoning model it is timing the start of
    // thinking on somebody else's network. Ours is the wait a user of ours
    // actually sat through.
    const ourTtft = definedNumbers(
      endpoints,
      (e) => measuredFor(signals, e).latencyP50Ms,
    );
    const p95s = definedNumbers(endpoints, (e) => e.latencyP95Ms);
    const p90s = definedNumbers(endpoints, (e) => e.latencyP90Ms);
    const latencies =
      ourTtft.length > 0 ? ourTtft : p95s.length > 0 ? p95s : p90s;
    if (latencies.length > 0) {
      const best = Math.min(...latencies);
      const percentile =
        ourTtft.length > 0 ? "p50" : p95s.length > 0 ? "p95" : "p90";
      const note =
        ourTtft.length > 0
          ? provenance(signals, endpoints, "latencyP50Ms")
          : percentile === "p90"
            ? " (source publishes no p95)"
            : "";
      rules.push(
        rule(
          "ttft-ceiling",
          "soft",
          best <= policy.maxTtftP95Ms,
          `best endpoint ${percentile} TTFT ${best.toFixed(0)} ms vs ceiling ${policy.maxTtftP95Ms.toString()} ms${note}`,
        ),
      );
    } else {
      rules.push(
        skippedRule(
          "ttft-ceiling",
          "soft",
          skipReasonFor(signals.sourcePublishes?.percentiles),
          "no endpoint carries a latency figure",
        ),
      );
    }
  }

  if (policy.maxPricePerMTok !== undefined) {
    const inputMedian = median(
      definedNumbers(endpoints, (e) => e.pricing.inputPerMTok),
    );
    const outputMedian = median(
      definedNumbers(endpoints, (e) => e.pricing.outputPerMTok),
    );
    const { input, output } = policy.maxPricePerMTok;
    if (input !== undefined) {
      rules.push(
        inputMedian !== undefined
          ? rule(
              "price-input-ceiling",
              "hard",
              inputMedian <= input,
              `pool median input $${inputMedian.toFixed(3)}/MTok vs ceiling $${input.toString()}`,
            )
          : skippedRule(
              "price-input-ceiling",
              "hard",
              "not-measured",
              "no endpoint carries an input price",
            ),
      );
    }
    if (output !== undefined) {
      rules.push(
        outputMedian !== undefined
          ? rule(
              "price-output-ceiling",
              "hard",
              outputMedian <= output,
              `pool median output $${outputMedian.toFixed(3)}/MTok vs ceiling $${output.toString()}`,
            )
          : skippedRule(
              "price-output-ceiling",
              "hard",
              "not-measured",
              "no endpoint carries an output price",
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
    } else {
      rules.push(
        skippedRule(
          "uptime-floor",
          "soft",
          skipReasonFor(signals.sourcePublishes?.uptime),
          "no endpoint carries a 1d uptime figure",
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
    } else {
      rules.push(
        skippedRule(
          "intelligence-floor",
          "soft",
          "not-measured",
          "no Artificial Analysis record matched — key unset, or the model is not graded there",
        ),
      );
    }
  }

  // Skipped rules count in NEITHER tally: absence of data is not evidence of
  // failure, and letting a skipped hard rule fail the report would let one
  // missing credential unpublish the fleet.
  const hardFailures = rules.filter(
    (r) => r.severity === "hard" && !r.passed && r.skipped === undefined,
  ).length;
  const softFailures = rules.filter(
    (r) => r.severity === "soft" && !r.passed && r.skipped === undefined,
  ).length;
  const skippedRules = rules.filter((r) => r.skipped !== undefined).length;

  return {
    passed: hardFailures === 0,
    hardFailures,
    softFailures,
    rules,
    skippedRules,
    evaluatedAt: now.toISOString(),
    excludedProviders: signals.excludedProviders,
  };
};

/**
 * Composite 0-100 health for a published model. Uptime dominates because an
 * endpoint that answers slowly still answers; the policy term captures
 * everything else the rules measured, and recent incidents are the only input
 * that comes from our own traffic rather than a vendor's dashboard.
 *
 * A rule skipped for `not-measured` costs exactly what a soft FAILURE costs,
 * and shares its cap. That is the conservative reading on purpose: before
 * skips existed, a measurement disappearing made the score RISE (the rule
 * vanished, its penalty with it), so a fleet losing its percentiles graded
 * healthier than one keeping them. "We cannot show it is fine" must never be
 * worth more than "it is fine", and pricing it as a failure guarantees the
 * score never improves when data goes missing. `not-published-by-source`
 * skips are free — a structural gap is a property of the transport, not a
 * regression to punish every night.
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

  const skippedNotMeasured = report
    ? report.rules.filter((r) => r.skipped === "not-measured").length
    : 0;
  const softPenalty = report
    ? Math.min(report.softFailures + skippedNotMeasured, 4) * 5
    : 0;
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
