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
import type { AssertionResult } from "../types";
import { CAPABILITIES } from "../types";
import type { FailedCheck, TaskOutput } from "./types";

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

/**
 * Mechanical zombie flag: the turn produced NO visible text and NO
 * transport error — the agent loop died silently. (A zombie that the
 * handler recovered via its fallback chain produces text, so it is
 * NOT flagged here — `fallback-served` carries that signal instead.)
 */
export const isZombie = (out: TaskOutput): boolean =>
  out.text.trim().length === 0 && out.error === undefined;

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
      score(configIds, {
        name: "zombie",
        value: isZombie(out) ? 1 : 0,
        dataType: "BOOLEAN",
        ...(out.finishReason !== undefined
          ? { comment: `finishReason=${out.finishReason}` }
          : {}),
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
    // Mechanical Zod validity of the turn's tool-call inputs (BFCL-AST
    // analogue on OUR tools). Emitted only when at least one call hit
    // a known schema — a turn with zero tool calls has no signal.
    const validity = out.toolCallValidity;
    if (validity && validity.total > 0) {
      evaluations.push(
        score(configIds, {
          name: "tool-call-validity",
          value: Number((validity.valid / validity.total).toFixed(4)),
          dataType: "NUMERIC",
          comment:
            validity.failures.length > 0
              ? validity.failures.join(" | ")
              : `${validity.valid.toString()}/${validity.total.toString()} valid`,
        }),
      );
    }
    if (out.stepsUsed !== undefined) {
      evaluations.push(
        score(configIds, {
          name: "steps-used",
          value: out.stepsUsed,
          dataType: "NUMERIC",
        }),
      );
    }
    if (out.fallbackServed === true) {
      evaluations.push(
        score(configIds, {
          name: "fallback-served",
          value: 1,
          dataType: "BOOLEAN",
          comment:
            "turn answered by the FALLBACK agent — not the candidate model",
        }),
      );
    }
    // Tool-calling EFFICIENCY (INFORMATIONAL — never folded into
    // correctness). Did the turn work WELL: too many calls, redundant
    // calls, erroring calls, or off-budget? See `evals/tool-efficiency.ts`.
    const eff = out.toolEfficiency;
    if (eff) {
      evaluations.push(
        score(configIds, {
          name: "tool-call-count",
          value: eff.totalCalls,
          dataType: "NUMERIC",
          ...(eff.totalCalls > 0
            ? {
                comment: Object.entries(eff.perTool)
                  .map(([n, c]) => `${n}×${c.toString()}`)
                  .join(" "),
              }
            : {}),
        }),
      );
      if (eff.totalCalls > 0) {
        evaluations.push(
          score(configIds, {
            name: "tool-error-rate",
            value: Number((eff.errorCalls / eff.totalCalls).toFixed(4)),
            dataType: "NUMERIC",
            ...(eff.errorThenRetry > 0
              ? {
                  comment: `${eff.errorCalls.toString()} errored, ${eff.errorThenRetry.toString()} error→retry`,
                }
              : {}),
          }),
          score(configIds, {
            name: "redundant-call-count",
            value: eff.redundantCalls,
            dataType: "NUMERIC",
          }),
        );
      }
      if (eff.budget) {
        evaluations.push(
          score(configIds, {
            name: "tool-budget-overage",
            value: eff.budget.overage + eff.budget.offAllowlist,
            dataType: "NUMERIC",
            comment: `${eff.totalCalls.toString()} calls${eff.budget.maxToolCalls !== undefined ? ` / max ${eff.budget.maxToolCalls.toString()}` : ""}; ${eff.budget.offAllowlist.toString()} off-allowlist`,
          }),
        );
      }
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
      // Mechanical gate signals (C3). All objective — no taxonomy.
      score(configIds, {
        name: "zombie-rate",
        value: mean(outputs.map((o) => (isZombie(o) ? 1 : 0))),
        dataType: "NUMERIC",
      }),
      score(configIds, {
        name: "avg-latency-ms",
        value: Math.round(mean(outputs.map((o) => o.latencyMs))),
        dataType: "NUMERIC",
      }),
      {
        name: "fallback-served-count",
        value: outputs.filter((o) => o.fallbackServed === true).length,
        dataType: "NUMERIC",
      },
    ];
    // Aggregate tool-call validity over ALL calls in the run (not the
    // mean of per-case ratios — a 1-call case must not weigh as much
    // as a 9-call case).
    const totals = outputs.reduce(
      (acc, o) => {
        if (o.toolCallValidity) {
          acc.valid += o.toolCallValidity.valid;
          acc.total += o.toolCallValidity.total;
        }
        return acc;
      },
      { valid: 0, total: 0 },
    );
    if (totals.total > 0) {
      evaluations.push(
        score(configIds, {
          name: "tool-call-validity",
          value: Number((totals.valid / totals.total).toFixed(4)),
          dataType: "NUMERIC",
          comment: `${totals.valid.toString()}/${totals.total.toString()} calls valid`,
        }),
      );
    }
    const stepCounts = outputs
      .map((o) => o.stepsUsed)
      .filter((s): s is number => typeof s === "number");
    if (stepCounts.length > 0) {
      evaluations.push(
        score(configIds, {
          name: "avg-steps-used",
          value: Number(mean(stepCounts).toFixed(2)),
          dataType: "NUMERIC",
        }),
      );
    }
    // Tool-calling EFFICIENCY aggregates (INFORMATIONAL). `tool-error-rate`
    // sums totals first (like validity — a 1-call case must not weigh as
    // much as a 9-call one). `error-then-retry` rides the error-rate
    // comment (not a seeded score — deferred until the metric is named
    // definitively; score configs cannot be deleted).
    const eff = outputs.reduce(
      (acc, o) => {
        if (o.toolEfficiency) {
          acc.cases++;
          acc.calls += o.toolEfficiency.totalCalls;
          acc.errors += o.toolEfficiency.errorCalls;
          acc.errorThenRetry += o.toolEfficiency.errorThenRetry;
          if (o.toolEfficiency.redundantCalls > 0) acc.redundantCases++;
        }
        return acc;
      },
      { cases: 0, calls: 0, errors: 0, errorThenRetry: 0, redundantCases: 0 },
    );
    if (eff.cases > 0) {
      evaluations.push(
        score(configIds, {
          name: "avg-tool-calls",
          value: Number((eff.calls / eff.cases).toFixed(2)),
          dataType: "NUMERIC",
          comment: `${eff.calls.toString()} calls over ${eff.cases.toString()} cases`,
        }),
        score(configIds, {
          name: "redundant-call-rate",
          value: Number((eff.redundantCases / eff.cases).toFixed(4)),
          dataType: "NUMERIC",
          comment: `${eff.redundantCases.toString()}/${eff.cases.toString()} cases had a redundant call`,
        }),
      );
      if (eff.calls > 0) {
        evaluations.push(
          score(configIds, {
            name: "tool-error-rate",
            value: Number((eff.errors / eff.calls).toFixed(4)),
            dataType: "NUMERIC",
            comment: `${eff.errors.toString()}/${eff.calls.toString()} calls errored, ${eff.errorThenRetry.toString()} error→retry`,
          }),
        );
      }
    }
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
