/**
 * Langfuse experiment task — runs ONE eval case end-to-end (the exact
 * `runner.ts` pipeline) and returns its outcome as `TaskOutput` for the
 * evaluators to score. The code case is the source of truth; the dataset
 * item only carries `caseId` (in `metadata`), which this task resolves
 * back to the registered case.
 */

import type { ExperimentTask } from "@langfuse/client";
import { allSuites } from "../cases";
import { CURATED } from "../curation";
import { runCase, type RunCaseOptions } from "../runner";
import type { Capability, EvalCase, EvalSuite } from "../types";
import type { TaskOutput } from "./types";

interface RegistryEntry {
  suite: EvalSuite;
  case: EvalCase;
}

/** caseId → { suite, case }. caseIds are unique across suites. */
export const buildCaseRegistry = (): Map<string, RegistryEntry> => {
  const registry = new Map<string, RegistryEntry>();
  for (const suite of allSuites) {
    for (const c of suite.cases) {
      registry.set(c.id, { suite, case: c });
    }
  }
  return registry;
};

const resolveCapability = (c: EvalCase): Capability =>
  CURATED[c.id]?.capability ?? "reasoning";

/**
 * Read `caseId` off the item metadata. The task param is a union
 * (ExperimentItem | DatasetItem) whose `metadata` widens to `{}`, so
 * narrow with `in` instead of an unsafe cast.
 */
const readCaseId = (item: { metadata?: unknown }): string => {
  const meta = item.metadata;
  if (meta && typeof meta === "object" && "caseId" in meta) {
    const value = meta.caseId;
    if (typeof value === "string") return value;
  }
  return "";
};

/**
 * Build the experiment task. `deterministicOnly` skips the judge (PR
 * tier). The returned task resolves `metadata.caseId` → the code case,
 * runs it, and shapes a `TaskOutput`.
 */
export const buildExperimentTask = (opts?: RunCaseOptions): ExperimentTask => {
  const registry = buildCaseRegistry();
  return async (item) => {
    const caseId = readCaseId(item);
    const entry = registry.get(caseId);
    if (!entry) {
      const out: TaskOutput = {
        caseId,
        suite: "(unknown)",
        capability: "reasoning",
        text: "",
        passed: false,
        latencyMs: 0,
        error: `case not found in registry: ${caseId}`,
        assertionResults: [],
        toolNames: [],
      };
      return out;
    }
    const result = await runCase(entry.suite, entry.case, opts);
    const out: TaskOutput = {
      caseId: result.caseId,
      suite: result.suiteName,
      capability: resolveCapability(entry.case),
      text: result.invoke.text,
      passed: result.passed,
      latencyMs: result.invoke.latencyMs,
      ...(result.invoke.error !== undefined
        ? { error: result.invoke.error }
        : {}),
      ...(result.invoke.traceId !== undefined
        ? { traceId: result.invoke.traceId }
        : {}),
      assertionResults: result.assertions,
      toolNames: result.invoke.toolCalls.map((t) => t.name),
    };
    return out;
  };
};
