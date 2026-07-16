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
