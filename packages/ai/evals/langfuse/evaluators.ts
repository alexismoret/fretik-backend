/**
 * Langfuse experiment evaluators for the eval harness.
 *
 * Item-level: turn one case's `TaskOutput` into Langfuse scores — a
 * partial-credit `correctness` (mean of assertion scores), a `no-error`
 * boolean, a `failure-mode` category on failure, and `latency-ok` when a
 * latency assertion ran. Run-level: aggregate `correctness` overall and
 * PER CAPABILITY — that aggregate IS the baseline a change is measured
 * against. Names match the score configs seeded by
 * `scripts/seed-langfuse-eval-config.ts`; pass `configIds` so each score
 * is linked to its config (`configId`) for category/range validation —
 * the recommended Langfuse pattern.
 *
 * Deterministic checks run in BOTH CI tiers; the judge (which feeds the
 * partial credit inside `correctness`) only runs in the full tier. So in
 * `--deterministic-only` mode `correctness` reflects deterministic
 * assertions only — still a valid, cheaper regression signal.
 *
 * `dataType` is set EXPLICITLY: Langfuse infers NUMERIC from a number,
 * so BOOLEAN (0/1) and CATEGORICAL (string) MUST declare their type or
 * they would be ingested as plain numbers/categoricals incorrectly.
 */

import type { Evaluation, Evaluator, RunEvaluator } from "@langfuse/client";
import type { AssertionResult, Capability } from "../types";
import type { FailedCheck, TaskOutput } from "./types";

const CAPABILITIES: Capability[] = [
  "extraction",
  "generation",
  "external-actions",
  "reasoning",
];

/** name → Langfuse score-config id, for `configId` linkage (optional). */
export type ConfigIds = Partial<Record<string, string>>;

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const assertionScore = (a: AssertionResult): number =>
  a.score ?? (a.passed ? 1 : 0);

/**
 * Partial-credit correctness for one case: mean of its assertion scores.
 * Empty (e.g. a registry miss) → 0.
 */
export const caseCorrectness = (out: TaskOutput): number =>
  out.assertionResults.length === 0
    ? 0
    : mean(out.assertionResults.map(assertionScore));

/**
 * Mechanical label of the first failing assertion — what BROKE, not WHY.
 * The judge is not sub-categorised (its real sub-modes come from error
 * analysis, not from guessing here).
 */
const classifyFailedCheck = (out: TaskOutput): FailedCheck => {
  const failed = out.assertionResults.find((a) => !a.passed);
  if (!failed) return "judge";
  switch (failed.type) {
    case "toolUsed":
      return "tool-not-called";
    case "toolNotUsed":
      return "unexpected-tool";
    case "latencyUnder":
      return "latency";
    case "contains":
    case "regex":
      return "missing-text";
    case "noError":
      return "error";
    case "judge":
      return "judge";
    case "custom":
      return "custom";
  }
};

const failedMessages = (out: TaskOutput): string =>
  out.assertionResults
    .filter((a) => !a.passed)
    .map((a) => `${a.label}${a.message ? `: ${a.message}` : ""}`)
    .join(" | ") || "all assertions passed";

/** Build an Evaluation, attaching `configId` when one is registered. */
const score = (configIds: ConfigIds, base: Evaluation): Evaluation => {
  const id = configIds[base.name];
  return id ? { ...base, configId: id } : base;
};

/** Item-level evaluator → one Langfuse score array per case. */
export const buildItemEvaluator = (configIds: ConfigIds = {}): Evaluator => {
  return async ({ output }) => {
    const out: TaskOutput = output;
    const evaluations: Evaluation[] = [
      score(configIds, {
        name: "correctness",
        value: caseCorrectness(out),
        dataType: "NUMERIC",
        comment: out.passed ? "all assertions passed" : failedMessages(out),
      }),
      score(configIds, {
        name: "no-error",
        value: out.error ? 0 : 1,
        dataType: "BOOLEAN",
        ...(out.error ? { comment: out.error } : {}),
      }),
    ];
    if (!out.passed) {
      // `failed-check` = which assertion broke (mechanical). Free
      // categorical, NO score config: the real failure taxonomy is
      // discovered via error analysis, never seeded a priori.
      evaluations.push({
        name: "failed-check",
        value: classifyFailedCheck(out),
        dataType: "CATEGORICAL",
        comment: failedMessages(out),
      });
    }
    const latency = out.assertionResults.find((a) => a.type === "latencyUnder");
    if (latency) {
      evaluations.push(
        score(configIds, {
          name: "latency-ok",
          value: latency.passed ? 1 : 0,
          dataType: "BOOLEAN",
        }),
      );
    }
    return evaluations;
  };
};

/**
 * Run-level evaluator → overall + per-capability `correctness` + pass
 * rate. These attach to the dataset run = the BASELINE. Per-capability
 * scores make a single-capability regression visible even when the
 * overall holds.
 */
export const buildRunEvaluator = (configIds: ConfigIds = {}): RunEvaluator => {
  return async ({ itemResults }) => {
    const outputs: TaskOutput[] = itemResults.map((r) => r.output);
    const evaluations: Evaluation[] = [
      score(configIds, {
        name: "correctness",
        value: mean(outputs.map(caseCorrectness)),
        dataType: "NUMERIC",
        comment: `${outputs.length} cases`,
      }),
      {
        name: "pass-rate",
        value: mean(outputs.map((o) => (o.passed ? 1 : 0))),
        dataType: "NUMERIC",
      },
    ];
    for (const cap of CAPABILITIES) {
      const subset = outputs.filter((o) => o.capability === cap);
      if (subset.length === 0) continue;
      evaluations.push({
        name: `correctness:${cap}`,
        value: mean(subset.map(caseCorrectness)),
        dataType: "NUMERIC",
        comment: `${subset.length} cases`,
      });
    }
    return evaluations;
  };
};
