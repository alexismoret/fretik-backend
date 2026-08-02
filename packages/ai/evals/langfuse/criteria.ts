/**
 * Pure scoring for the C3 model-promotion gate: compare a baseline vs a
 * candidate `RunMetrics` snapshot and emit a verdict per criterion. No I/O,
 * no live service — `gate.ts` owns the runs and feeds the snapshots here.
 * Split out so the verdict logic is unit-testable without the live-experiment
 * import chain.
 */

import { MODEL_PROFILES } from "../../src/lib/model-registry/profiles";
import { CAPABILITIES, type Capability } from "../types";
import { GATE_CONFIG, type GateConfig } from "./gate-config";

export interface CapabilityMetric {
  value: number;
  cases: number;
}

/** Comparable metric snapshot of one run (live or stored). */
export interface RunMetrics {
  source: "live" | "stored";
  runName: string;
  datasetRunId?: string;
  correctness?: number;
  perCapability: Partial<Record<Capability, CapabilityMetric>>;
  toolCallValidity?: number;
  zombieRate?: number;
  avgLatencyMs?: number;
  costPerTurnUsd?: number;
  fallbackServedCount: number;
  // C11 tool-calling efficiency (advisory). errorThenRetryTotal is only
  // available from a live run (not a seeded score → absent for stored).
  avgToolCalls?: number;
  toolErrorRate?: number;
  redundantCallRate?: number;
  errorThenRetryTotal?: number;
}

export interface CriterionResult {
  name: string;
  verdict: "pass" | "fail" | "advisory" | "skipped";
  detail: string;
}

/**
 * Evaluate every gate criterion. `cfg` defaults to the live `GATE_CONFIG`;
 * tests pass an explicit config to exercise the advisory/enforced branches
 * without touching the environment.
 */
export const evaluateCriteria = (
  base: RunMetrics,
  cand: RunMetrics,
  candidateKey: string,
  cfg: GateConfig = GATE_CONFIG,
): CriterionResult[] => {
  const out: CriterionResult[] = [];

  for (const cap of CAPABILITIES) {
    const b = base.perCapability[cap];
    const c = cand.perCapability[cap];
    if (!b || !c) continue;
    const dropCases = (b.value - c.value) * c.cases;
    out.push({
      name: `correctness:${cap}`,
      verdict:
        dropCases <= cfg.maxCapabilityDropCases + 1e-9
          ? "pass"
          : cfg.correctnessEnforced
            ? "fail"
            : "advisory",
      detail: `${b.value.toFixed(3)} → ${c.value.toFixed(3)} (${dropCases <= 0 ? "no drop" : `${dropCases.toFixed(2)} case-equivalents lost`}, max ${cfg.maxCapabilityDropCases.toString()})`,
    });
  }

  if (
    base.toolCallValidity !== undefined &&
    cand.toolCallValidity !== undefined
  ) {
    out.push({
      name: "tool-call-validity",
      verdict:
        cand.toolCallValidity >= base.toolCallValidity - cfg.epsilon
          ? "pass"
          : "fail",
      detail: `${base.toolCallValidity.toFixed(3)} → ${cand.toolCallValidity.toFixed(3)} (ε=${cfg.epsilon.toString()})`,
    });
  } else {
    out.push({
      name: "tool-call-validity",
      verdict: "skipped",
      detail: "metric missing on one side",
    });
  }

  if (base.zombieRate !== undefined && cand.zombieRate !== undefined) {
    out.push({
      name: "zombie-rate",
      verdict:
        cand.zombieRate <= base.zombieRate + cfg.epsilon ? "pass" : "fail",
      detail: `${base.zombieRate.toFixed(3)} → ${cand.zombieRate.toFixed(3)} (ε=${cfg.epsilon.toString()})`,
    });
  }

  const profile = MODEL_PROFILES[candidateKey];
  if (profile && cand.costPerTurnUsd !== undefined) {
    const envelope = cfg.costEnvelopeUsdPerTurn[profile.assessment.costClass];
    const within = cand.costPerTurnUsd <= envelope;
    out.push({
      name: "cost-per-turn-usd",
      verdict: cfg.costCalibrated ? (within ? "pass" : "fail") : "advisory",
      detail: `$${cand.costPerTurnUsd.toFixed(4)}/turn vs ${profile.assessment.costClass} envelope $${envelope.toString()}${cfg.costCalibrated ? "" : " — UNCALIBRATED, advisory only (see gate-config.ts)"}`,
    });
  }

  if (base.avgLatencyMs !== undefined && cand.avgLatencyMs !== undefined) {
    const cap = cfg.latencyFactor * base.avgLatencyMs;
    out.push({
      name: "avg-latency-ms",
      verdict: cand.avgLatencyMs <= cap ? "pass" : "fail",
      detail: `${Math.round(base.avgLatencyMs).toString()}ms → ${Math.round(cand.avgLatencyMs).toString()}ms (cap ${Math.round(cap).toString()}ms = ${cfg.latencyFactor.toString()}×)`,
    });
  }

  out.push({
    name: "fallback-served",
    verdict:
      cand.fallbackServedCount <=
      base.fallbackServedCount + cfg.maxFallbackServedDelta
        ? "pass"
        : "fail",
    detail: `${cand.fallbackServedCount.toString()} candidate case(s) answered by the fallback agent vs ${base.fallbackServedCount.toString()} baseline (cap ${(base.fallbackServedCount + cfg.maxFallbackServedDelta).toString()} = baseline + ${cfg.maxFallbackServedDelta.toString()})`,
  });

  // ── C11 tool-calling EFFICIENCY (advisory until calibrated) ──────────
  // ADVISORY by default: reported, never failing. A reviewed flip of
  // `efficiencyEnforced` (after a baseline sets real envelopes) turns
  // these into pass/fail — same discipline as the cost criterion.
  const env = cfg.efficiencyEnvelope;
  const note = cfg.efficiencyEnforced ? "" : " — advisory (uncalibrated)";
  const effVerdict = (within: boolean): CriterionResult["verdict"] =>
    cfg.efficiencyEnforced ? (within ? "pass" : "fail") : "advisory";

  if (base.avgToolCalls !== undefined && cand.avgToolCalls !== undefined) {
    const capCalls = env.avgToolCallsFactor * base.avgToolCalls;
    out.push({
      name: "avg-tool-calls",
      verdict: effVerdict(cand.avgToolCalls <= capCalls + 1e-9),
      detail: `${base.avgToolCalls.toFixed(2)} → ${cand.avgToolCalls.toFixed(2)} (cap ${capCalls.toFixed(2)} = ${env.avgToolCallsFactor.toString()}×)${note}`,
    });
  }
  if (cand.toolErrorRate !== undefined) {
    out.push({
      name: "tool-error-rate",
      verdict: effVerdict(cand.toolErrorRate <= env.maxToolErrorRate),
      detail: `${(base.toolErrorRate ?? 0).toFixed(3)} → ${cand.toolErrorRate.toFixed(3)} (max ${env.maxToolErrorRate.toString()})${cand.errorThenRetryTotal !== undefined ? `, ${cand.errorThenRetryTotal.toString()} error→retry` : ""}${note}`,
    });
  }
  if (cand.redundantCallRate !== undefined) {
    out.push({
      name: "redundant-call-rate",
      verdict: effVerdict(cand.redundantCallRate <= env.maxRedundantCallRate),
      detail: `${(base.redundantCallRate ?? 0).toFixed(3)} → ${cand.redundantCallRate.toFixed(3)} (max ${env.maxRedundantCallRate.toString()})${note}`,
    });
  }

  return out;
};
