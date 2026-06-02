/**
 * Shared types for the Langfuse experiment wiring of the eval harness.
 */

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
  /** Server `chatbot-turn` trace id → fetch the turn's agent cost. */
  traceId?: string;
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
