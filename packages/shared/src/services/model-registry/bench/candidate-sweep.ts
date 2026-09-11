import { normalizeProviderName } from "../../../model-registry/provider-names";
import type { LiveModelState } from "../../../model-registry/types";
import { raiseModelAlert } from "../alerts";
import { readRecentBenchRuns, recordBenchRuns } from "../bench-runs";
import { readAllLiveStateRows } from "../live";
import { wireNameFor } from "../sync/sources/provider-probe";
import {
  canProbeIntegrity,
  probeableTransports,
  probeIntegrity,
} from "./integrity-probe";

/**
 * Measure what a promotion decision needs, before anybody asks for it.
 *
 * The registry discovers candidates on its own and then stopped: the alert it
 * raised said "publish it by hand after a bench run", and the bench it meant
 * was a CLI nobody ran, could not measure a gateway model, and wrote its
 * results to a terminal. So the one decision this system deliberately leaves
 * to a person — promote or not — was the decision with the least evidence
 * behind it.
 *
 * This sweep closes that. Every candidate with more than one upstream gets its
 * integrity gate measured automatically, once, and the result is on the
 * scorecard when someone opens it.
 *
 * ## What is probed, and what is not
 *
 * An UPSTREAM nobody has measured, wherever it sits. That is every host of a
 * new candidate, and — since 2026-09-02 — a host that has just entered a
 * PUBLISHED model's pool.
 *
 * The original rule was "candidates only", on the reading that a published
 * model's integrity is watched continuously and for free by the runtime
 * detectors on real traffic. That still holds for a host that has been serving:
 * traffic is a better signal than a synthetic prompt. It does not hold for a
 * host that has just been admitted and has served nothing — and pools now
 * widen, because `only` stopped being a ratchet the same day. Probing per
 * upstream rather than per row is what keeps both true: an admitted host is
 * measured once, an established one is left to the traffic that already
 * watches it.
 *
 * ## Why only multi-upstream candidates
 *
 * The measurement answers "which of these hosts deserve to be in the pool".
 * With one host there is no pool decision: excluding it does not reroute the
 * model, it removes it. Measured 2026-09-01 across 25 candidates, only ONE had
 * more than one distinct upstream — the rest had several endpoints belonging to
 * a single company, which reads as a pool and is not one. Counting DISTINCT
 * upstreams rather than endpoints is what keeps this sweep small.
 */

/**
 * Upstreams probed per night, across every candidate. The probe is a few
 * hundred tokens, so this is a guard against a runaway loop rather than a
 * budget: at three runs each it is a few thousand tokens a night.
 */
export const INTEGRITY_MAX_PROBES_PER_NIGHT = 60;

/** Candidates measured per night, so a burst of discovery cannot flood a pass. */
export const BENCH_MAX_CANDIDATES_PER_NIGHT = 4;

/**
 * How long a measurement stands before a candidate is worth re-probing. Long,
 * because a candidate that has not been promoted in a month is not waiting on
 * fresher evidence — and re-measuring the same untouched rows nightly is how a
 * cheap sweep stops being cheap.
 */
export const BENCH_RESTALE_DAYS = 30;

export interface CandidateSweepStats {
  candidatesConsidered: number;
  candidatesProbed: number;
  upstreamsProbed: number;
  /** Upstreams whose probe found a truncation — the finding worth waking for. */
  upstreamsFailing: number;
  /**
   * Rows skipped because their own transport is not one this process can call.
   *
   * Counted rather than ignored, because "the bench found nothing" and "the
   * bench could not reach anything" are different reports and were, until
   * 2026-09-11, indistinguishable.
   */
  rowsOnUnusableTransport: number;
  errors: string[];
}

/** Distinct upstream names in a row's recorded endpoints. */
const distinctUpstreams = (row: LiveModelState): string[] => [
  ...new Set(
    (row.endpointStats ?? []).map((endpoint) =>
      normalizeProviderName(endpoint.provider),
    ),
  ),
];

/**
 * One sweep. Returns what it did; raises one alert per candidate measured, so
 * the finding reaches the digest rather than only a log.
 */
export const runCandidateBenchSweep = async (options?: {
  now?: Date;
}): Promise<CandidateSweepStats> => {
  const now = options?.now ?? new Date();
  const stats: CandidateSweepStats = {
    candidatesConsidered: 0,
    candidatesProbed: 0,
    upstreamsProbed: 0,
    upstreamsFailing: 0,
    rowsOnUnusableTransport: 0,
    errors: [],
  };

  const rows = await readAllLiveStateRows();
  const staleBefore = new Date(
    now.getTime() - BENCH_RESTALE_DAYS * 24 * 60 * 60_000,
  );

  for (const row of rows) {
    if (stats.candidatesProbed >= BENCH_MAX_CANDIDATES_PER_NIGHT) break;
    if (stats.upstreamsProbed >= INTEGRITY_MAX_PROBES_PER_NIGHT) break;
    if (row.status === "retired") continue;
    // A model is benched ON THE TRANSPORT IT ROUTES THROUGH, or not at all.
    // `row.transport` is where its traffic goes, so it is the only transport
    // whose hosts a measurement describes — and when this process holds no
    // credential for it, the honest outcome is a skip with a reason rather than
    // a probe that spends a budget slot to return nothing.
    if (!canProbeIntegrity(row.transport)) {
      stats.rowsOnUnusableTransport += 1;
      continue;
    }

    const upstreams = distinctUpstreams(row);
    // One host is not a pool: there is no membership question to answer.
    if (upstreams.length < 2) continue;
    stats.candidatesConsidered += 1;

    const modelId = row.modelIds[row.transport];
    if (modelId === undefined) continue;

    /** Hosts whose measurement still stands — nothing to learn by repeating it. */
    let measured: Set<string>;
    try {
      const recent = await readRecentBenchRuns(row.profileKey, {
        since: staleBefore,
      });
      measured = new Set(
        recent.map((entry) => normalizeProviderName(entry.provider)),
      );
    } catch (err: unknown) {
      stats.errors.push(
        `${row.profileKey}: could not read previous bench runs: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const unmeasured = upstreams.filter((provider) => !measured.has(provider));
    // Every host already carries a standing measurement. On a published model
    // that is the normal state, and re-probing it would spend tokens to
    // reproduce what real traffic reports for free.
    if (unmeasured.length === 0) continue;

    const measurements: {
      provider: string;
      intactPassed: number;
      intactTotal: number;
      failures: number;
      note?: string;
    }[] = [];

    for (const provider of unmeasured) {
      if (stats.upstreamsProbed >= INTEGRITY_MAX_PROBES_PER_NIGHT) break;
      const wireName = wireNameFor(row.endpointStats, provider, row.transport);
      // A probe we cannot address correctly must not run: an unknown name is
      // rejected by the gateway and ignored by OpenRouter, so its result would
      // describe the request rather than the host.
      if (wireName === undefined) continue;

      try {
        const result = await probeIntegrity({
          transport: row.transport,
          modelId,
          provider,
          wireName,
        });
        // Counted only once a probe ACTUALLY RAN. It used to be counted before
        // the call, so a transport that refuses every request still consumed
        // the whole nightly budget and stopped the sweep before it reached a
        // row it could have measured.
        if (result === undefined) continue;
        stats.upstreamsProbed += 1;
        if (result.passed < result.total - result.inconclusive) {
          stats.upstreamsFailing += 1;
        }
        measurements.push({
          provider: result.provider,
          intactPassed: result.passed,
          intactTotal: result.total,
          failures: result.inconclusive,
          ...(result.note === undefined ? {} : { note: result.note }),
        });
      } catch (err: unknown) {
        stats.errors.push(
          `${row.profileKey}/${provider}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (measurements.length === 0) continue;

    try {
      await recordBenchRuns({
        profileKey: row.profileKey,
        transport: row.transport,
        ranAt: now,
        measurements,
      });
      stats.candidatesProbed += 1;
    } catch (err: unknown) {
      stats.errors.push(
        `${row.profileKey}: could not record bench runs: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const clean = measurements.filter(
      (measurement) =>
        measurement.intactPassed >=
        measurement.intactTotal - measurement.failures,
    );
    const mutilating = measurements.filter(
      (measurement) =>
        measurement.intactPassed <
        measurement.intactTotal - measurement.failures,
    );
    const published = row.status === "published";
    await raiseModelAlert({
      kind: "bench-verdict",
      // A truncating host is worth reading before a promotion; the same finding
      // on a PUBLISHED model is about traffic being served right now. A clean
      // sweep is a fact for the scorecard, not a message.
      severity:
        mutilating.length === 0 ? "info" : published ? "critical" : "warning",
      modelKey: row.profileKey,
      message:
        mutilating.length > 0
          ? `${row.profileKey}: ${mutilating.map((m) => `${m.provider} ${m.intactPassed.toString()}/${m.intactTotal.toString()}`).join(", ")} MUTILATED an answer ending in a tool call — every agent turn ends that way. ${
              published
                ? "This model is PUBLISHED and the host is in its pool: quarantine it."
                : "Exclude them before promoting."
            } ${clean.length.toString()} of ${measurements.length.toString()} newly measured upstream(s) came back intact.`
          : `${row.profileKey}: all ${measurements.length.toString()} newly measured upstream(s) kept an answer ending in a tool call intact.`,
      context: { transport: row.transport, measurements, status: row.status },
    });
  }

  // A sweep that measured nothing because it could reach nothing is a WIRING
  // problem, and it used to look exactly like a quiet night. Raised once per
  // pass rather than per row, and only when the sweep is entirely idle: a fleet
  // with a handful of gateway-only candidates alongside a working OpenRouter
  // pool is normal and needs no message.
  if (stats.rowsOnUnusableTransport > 0 && stats.upstreamsProbed === 0) {
    const usable = probeableTransports();
    await raiseModelAlert({
      kind: "bench-verdict",
      severity: "warning",
      message: `The integrity bench measured nothing: ${stats.rowsOnUnusableTransport.toString()} row(s) route through a transport this deployment cannot call, and ${usable.length === 0 ? "no transport has a credential set" : `only ${usable.join(", ")} does`}. Set the missing API key, or switch those rows onto a transport in use (\`models:admin -- transport <key> <transport>\`).`,
      context: {
        rowsOnUnusableTransport: stats.rowsOnUnusableTransport,
        probeableTransports: usable,
      },
    });
  }

  return stats;
};
