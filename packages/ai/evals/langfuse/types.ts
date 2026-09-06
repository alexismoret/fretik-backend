/**
 * Shared types for the Langfuse experiment wiring of the eval harness.
 */

import type { ToolEfficiencySummary } from "../tool-efficiency";
import type { AssertionResult, Capability } from "../types";

/** Where a dataset item came from. Drives weighting/filtering later. */
export type DatasetOrigin = "synthetic" | "prod";

/**
 * Metadata stored on each Langfuse dataset item (`chatbot-eval`). The
 * code keeps the executable case (assertions/seed/cleanup); the dataset
 * mirror carries only what the UI + experiment runner need, keyed by
 * `caseId` so the task can resolve back to the code case.
 */
export interface DatasetItemMetadata {
  caseId: string;
  suite: string;
  capability: Capability;
  tags: string[];
  fixtures: string[];
  description: string;
  origin: DatasetOrigin;
  /** Part of the PR smoke set (~1 per capability). */
  smoke: boolean;
  /**
   * Run tier (mirrors `CuratedCase.tier`). Absent = core behavioral
   * case (runs on every full baseline); `"model-gate"` = per-model
   * probe, selected only by `--all`, `--smoke`, `--capability`, or the
   * `evals:gate` promotion runs.
   */
  tier?: "model-gate";
  [key: string]: unknown;
}

/**
 * Output of the experiment task — the full case outcome, returned so the
 * Langfuse evaluators can score it WITHOUT re-running anything. Plain
 * serialisable data (it becomes the trace output).
 */
export interface TaskOutput {
  caseId: string;
  suite: string;
  capability: Capability;
  text: string;
  passed: boolean;
  latencyMs: number;
  error?: string;
  assertionResults: AssertionResult[];
  toolNames: string[];
  /** Server `chatbot-turn` trace id → cross-check the turn's cost. */
  traceId?: string;
  /**
   * What the turn cost, as the SERVER counted it (`src/lib/turn-usage.ts`).
   *
   * The authority, with Langfuse demoted to a cross-check: summing a trace's
   * observations reported 22x the truth for two days in September 2026,
   * because a hot-reloaded dev process had registered the telemetry
   * integration 22 times and nothing downstream could tell.
   */
  spend?: {
    steps: number;
    costedSteps: number;
    costUsd: number;
    byAgent?: Record<string, { steps: number; costUsd: number }>;
  };
  /** Turn finish reason — feeds the `zombie` mechanical score. */
  finishReason?: string;
  /** Agent-loop steps in the turn (`start-step` SSE frames). */
  stepsUsed?: number;
  /**
   * Mechanical Zod validation of the turn's tool-call inputs (see
   * `evals/tool-schemas.ts`). Summary only — raw inputs stay out of
   * the trace output.
   */
  toolCallValidity?: {
    total: number;
    valid: number;
    unknown: number;
    failures: string[];
  };
  /**
   * Mechanical tool-calling EFFICIENCY snapshot (call count, per-tool
   * counts, error / error-then-retry / redundancy, optional per-case
   * budget adherence). Summary only — raw inputs/outputs stay out of
   * the trace (see `evals/tool-efficiency.ts`). INFORMATIONAL: surfaced
   * as its own scores + the gate's advisory section, NEVER folded into
   * `correctness` and never a pass/fail criterion in this chantier.
   */
  toolEfficiency?: ToolEfficiencySummary;
  /**
   * True when the FALLBACK agent answered (silent failover or zombie
   * recovery). A candidate gate run must flag these — they were not
   * served by the candidate model.
   */
  fallbackServed?: boolean;
  /** Registry profile key that served the turn (finish telemetry). */
  modelProfileKey?: string;
  [key: string]: unknown;
}

/**
 * MECHANICAL label of which assertion kind failed — NOT a failure
 * taxonomy. The real failure taxonomy is DISCOVERED via error analysis
 * (open-coding prod traces, gated until prod exists), never invented a
 * priori (a pre-defined list causes confirmation bias —
 * langfuse.com/guides/cookbook/error-analysis-llm-applications). Each
 * value maps 1:1 to a failing assertion type; the judge is NOT
 * sub-categorised here (its real sub-modes come from error analysis).
 * Emitted as a free categorical score (no score config).
 */
export type FailedCheck =
  | "tool-not-called"
  | "unexpected-tool"
  | "latency"
  | "missing-text"
  | "error"
  | "judge"
  | "custom";
