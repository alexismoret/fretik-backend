/**
 * Unit tests for the gate's correctness verdict (`evals/langfuse/criteria.ts`).
 * Pure + deterministic — no live service. Covers the gate-advisory change: a
 * per-capability correctness drop past `maxCapabilityDropCases` is ADVISORY by
 * default (lets a smarter frontier candidate gate through) and only DISQUALIFIES
 * when `correctnessEnforced` is on.
 */

import { describe, expect, test } from "bun:test";
import {
  evaluateCriteria,
  type RunMetrics,
} from "../../../evals/langfuse/criteria";
import {
  GATE_CONFIG,
  type GateConfig,
} from "../../../evals/langfuse/gate-config";

// Minimal snapshot: one capability + the always-present `fallback-served`
// criterion. Other criteria stay `skipped`/absent (metrics undefined), which
// is irrelevant to the correctness verdict under test.
const metrics = (extractionValue: number, cases: number): RunMetrics => ({
  source: "live",
  runName: "test",
  perCapability: { extraction: { value: extractionValue, cases } },
  fallbackServedCount: 0,
});

const cfgWith = (correctnessEnforced: boolean): GateConfig => ({
  ...GATE_CONFIG,
  maxCapabilityDropCases: 1,
  correctnessEnforced,
});

const correctnessVerdict = (
  base: RunMetrics,
  cand: RunMetrics,
  cfg: GateConfig,
): string | undefined =>
  evaluateCriteria(base, cand, "minimax-m3", cfg).find(
    (c) => c.name === "correctness:extraction",
  )?.verdict;

describe("evaluateCriteria — correctness advisory vs enforced", () => {
  // 5 case-equivalents lost ((1.0 - 0.5) × 10), well past the max of 1.
  const base = metrics(1.0, 10);
  const regressed = metrics(0.5, 10);

  test("drop past threshold is ADVISORY when correctnessEnforced is false", () => {
    expect(correctnessVerdict(base, regressed, cfgWith(false))).toBe(
      "advisory",
    );
  });

  test("drop past threshold is FAIL when correctnessEnforced is true", () => {
    expect(correctnessVerdict(base, regressed, cfgWith(true))).toBe("fail");
  });

  test("no drop is PASS regardless of enforcement", () => {
    const same = metrics(1.0, 10);
    expect(correctnessVerdict(base, same, cfgWith(false))).toBe("pass");
    expect(correctnessVerdict(base, same, cfgWith(true))).toBe("pass");
  });

  test("drop within the case-equivalent threshold is PASS", () => {
    // (1.0 - 0.9) × 8 = 0.8 ≤ 1 → pass even when enforced.
    const tiny = metrics(0.9, 8);
    expect(correctnessVerdict(metrics(1.0, 8), tiny, cfgWith(true))).toBe(
      "pass",
    );
  });

  test("an advisory correctness drop never disqualifies the run", () => {
    const criteria = evaluateCriteria(
      base,
      regressed,
      "minimax-m3",
      cfgWith(false),
    );
    expect(criteria.some((c) => c.verdict === "fail")).toBe(false);
  });
});
