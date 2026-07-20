import {
  approvalDeferred,
  approvalPendingId,
} from "@fretik/shared/services/ai/approval-pending";
import type { StopCondition, ToolSet } from "ai";
import type { ResolvedModel } from "../../lib/model-registry/resolve";

/**
 * Stop the agent loop the moment a tool result parks on a HITL approval OR was
 * single-flight-deferred (another approval already pending). Matched by output
 * SHAPE (`approvalPendingId` / `approvalDeferred`), never by tool name, so every
 * kind stops the turn identically — `python` (a `run_plan` plan or a gated
 * `record_write` write) and the workflow `askUserQuestion`. Deferred is included
 * for the all-deferred edge (e.g. a sub-agent racing a turn that already has a
 * pending row): without it the agent would re-emit the deferred call and loop.
 * Load-bearing; shared verbatim by the chatbot and workflow agents.
 */
export const stopOnPendingApproval = <
  TTools extends ToolSet,
>(): StopCondition<TTools> => {
  return ({ steps }) => {
    const lastStep = steps.at(-1);
    if (lastStep === undefined) return false;
    return lastStep.toolResults.some(
      (tr) =>
        approvalPendingId(tr.output) !== null ||
        approvalDeferred(tr.output) !== null,
    );
  };
};

/**
 * Stop the agent loop the moment a tool result reports a background run in
 * flight (`backgroundRun: true` — set by `manageWorkflow run_test`). Matched
 * by output SHAPE, never by tool name, mirroring `stopOnPendingApproval`: the
 * launching turn ends immediately and the conversation is resumed by the
 * run-completion continuation instead of the model polling or sleeping.
 */
export const stopOnBackgroundLaunch = <
  TTools extends ToolSet,
>(): StopCondition<TTools> => {
  return ({ steps }) => {
    const lastStep = steps.at(-1);
    if (lastStep === undefined) return false;
    return lastStep.toolResults.some(
      (tr) =>
        tr.output !== null &&
        typeof tr.output === "object" &&
        "backgroundRun" in tr.output &&
        tr.output.backgroundRun === true,
    );
  };
};

/** `{ error, code }` failure envelope check (the `tool-error-codes.ts`
 * contract) — returns the code, or null for a success/foreign shape. */
const toolFailureCode = (output: unknown): string | null => {
  if (output === null || typeof output !== "object") return null;
  if (!("error" in output) || !("code" in output)) return null;
  return typeof output.error === "string" && typeof output.code === "string"
    ? output.code
    : null;
};

export interface ToolErrorRun {
  count: number;
  toolName: string;
  code: string;
}

/**
 * The TRAILING run of tool results where the same tool failed with the same
 * error code, across step boundaries (parallel same-step failures count).
 * Any success, different code, or different tool resets it. Instrument of the
 * loop guard: prod showed a 17-call identical-failure loop with no brake.
 */
export const trailingToolErrorRun = (
  steps: ReadonlyArray<{
    toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>,
): ToolErrorRun | null => {
  let run: ToolErrorRun | null = null;
  for (const step of steps) {
    for (const tr of step.toolResults) {
      const code = toolFailureCode(tr.output);
      if (code === null) {
        run = null;
      } else if (run && run.toolName === tr.toolName && run.code === code) {
        run = { count: run.count + 1, toolName: run.toolName, code: run.code };
      } else {
        run = { count: 1, toolName: tr.toolName, code };
      }
    }
  }
  return run;
};

/**
 * Hard backstop of the loop guard: end the turn once the same tool has failed
 * with the same error code `limit` times in a row. The softer steer fires
 * earlier (the `[loop-guard]` message injected in `prepareStep` — see
 * `agent-builder.ts`); this stops the burn when the model ignores it.
 */
export const stopOnRepeatedToolErrors = <TTools extends ToolSet>(
  limit: number,
): StopCondition<TTools> => {
  return ({ steps }) => (trailingToolErrorRun(steps)?.count ?? 0) >= limit;
};

/**
 * Per-replica memoization of agent sets, one per serving profile. AgentSets are
 * STATELESS singletons (per-request state is born inside `prepareCall`), so
 * every replica builds identical sets from code — no cross-replica
 * coordination. Bounded by the model registry: the caller resolves the profile
 * before calling in, and `resolveChatModelForProfile` throws on unknown keys.
 */
export const memoizeAgentSets = <TSet>(
  make: (resolved: ResolvedModel) => TSet,
): ((resolved: ResolvedModel) => TSet) => {
  const cache = new Map<string, TSet>();
  return (resolved) => {
    const key = resolved.profile.key;
    const cached = cache.get(key);
    if (cached) return cached;
    const set = make(resolved);
    cache.set(key, set);
    return set;
  };
};
