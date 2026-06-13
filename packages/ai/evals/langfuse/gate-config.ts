/**
 * Pass/fail envelopes for the C3 model-promotion gate (`gate.ts`).
 * This file is the SINGLE place criteria are tuned: every value is
 * env-overridable for a one-off experiment, but a permanent change is
 * a reviewed edit here.
 */

import type { CostClass } from "../../src/lib/model-registry/types";

const num = (env: string | undefined, fallback: number): number => {
  if (env === undefined || env === "") return fallback;
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
};

export interface GateConfig {
  /** Tolerance on ratio metrics (tool-call-validity, zombie-rate). */
  epsilon: number;
  /**
   * Candidate avg latency must stay ≤ factor × baseline. Calibrated
   * 2026-06-12: the SAME model (M2.7) measured avg-latency 25.4s /
   * 31.1s / 33.4s / 35.7s across four runs — a 1.41× same-model
   * spread, so any factor below ~1.5 fails on environmental noise
   * (provider load), not on the candidate.
   */
  latencyFactor: number;
  /** Max candidate cases allowed to be served by the fallback agent. */
  maxFallbackServed: number;
  /**
   * Max per-capability correctness drop, in CASE-EQUIVALENTS
   * (drop × number of candidate cases in the capability ≤ this).
   */
  maxCapabilityDropCases: number;
  /**
   * Cost envelope per turn by `assessment.costClass` (USD).
   * UNCALIBRATED until the self-test run (`gate --candidate <current
   * chat profile>`) produces real cost-per-turn numbers — while
   * `costCalibrated` is false the cost criterion is ADVISORY
   * (reported, never failing). Calibrate from the self-test, edit the
   * numbers here, then set `GATE_COST_CALIBRATED=1` (env) or flip the
   * default below in a reviewed PR.
   */
  costCalibrated: boolean;
  costEnvelopeUsdPerTurn: Record<CostClass, number>;
  /**
   * Tool-calling EFFICIENCY enforcement (C11). UNCALIBRATED — the
   * efficiency criteria stay ADVISORY (reported, never failing) until a
   * baseline run sets real envelopes below AND `GATE_EFFICIENCY_ENFORCED=1`
   * (env) or a reviewed flip here. Same calibrate-then-enforce discipline
   * as `costCalibrated`: no placeholder ever gates a promotion.
   */
  efficiencyEnforced: boolean;
  efficiencyEnvelope: {
    /** Candidate avg-tool-calls ≤ factor × baseline. */
    avgToolCallsFactor: number;
    /** Candidate run-level tool-error-rate ≤ this. */
    maxToolErrorRate: number;
    /** Candidate run-level redundant-call-rate ≤ this. */
    maxRedundantCallRate: number;
  };
}

export const GATE_CONFIG: GateConfig = {
  epsilon: num(process.env.GATE_EPSILON, 0.02),
  latencyFactor: num(process.env.GATE_LATENCY_FACTOR, 1.5),
  maxFallbackServed: num(process.env.GATE_MAX_FALLBACK_SERVED, 1),
  maxCapabilityDropCases: num(process.env.GATE_MAX_CAPABILITY_DROP_CASES, 1),
  costCalibrated: process.env.GATE_COST_CALIBRATED === "1",
  // PLACEHOLDERS pending self-test calibration (see costCalibrated).
  costEnvelopeUsdPerTurn: {
    premium: num(process.env.GATE_COST_PREMIUM_USD, 0.25),
    standard: num(process.env.GATE_COST_STANDARD_USD, 0.08),
    budget: num(process.env.GATE_COST_BUDGET_USD, 0.03),
  },
  efficiencyEnforced: process.env.GATE_EFFICIENCY_ENFORCED === "1",
  // PLACEHOLDERS pending baseline calibration (see efficiencyEnforced).
  efficiencyEnvelope: {
    avgToolCallsFactor: num(process.env.GATE_AVG_TOOL_CALLS_FACTOR, 1.5),
    maxToolErrorRate: num(process.env.GATE_MAX_TOOL_ERROR_RATE, 0.15),
    maxRedundantCallRate: num(process.env.GATE_MAX_REDUNDANT_CALL_RATE, 0.1),
  },
};

/**
 * Grade-suggestion thresholds. The gate only SUGGESTS grades — a
 * human commits them into `profiles.ts` (the PR is the promotion).
 */
export const TOOL_GRADE_THRESHOLDS = { a: 0.95, b: 0.85 } as const;
export const IF_GRADE_THRESHOLDS = { a: 0.9, b: 0.75 } as const;
export const SO_GRADE_THRESHOLDS = { a: 0.95, b: 0.7 } as const;
