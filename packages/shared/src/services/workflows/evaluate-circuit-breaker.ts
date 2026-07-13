import db from "../../db";
import type { WorkflowRunError } from "../../schemas/workflows";
import { pauseWorkflow } from "./pause";

/**
 * Circuit breaker: auto-pause a workflow after N consecutive PLAYBOOK-failed
 * runs, so a broken playbook (or a cron that fails every hour) can't burn the
 * team's budget indefinitely with no one watching. Pausing already stops every
 * launch path — cron schedule dropped, event sweep + create worker + cron-fire
 * all gate on `status='active'` — and the `pausedReason`
 * (`circuit_breaker:<N>`) surfaces WHY in the UI. Re-activating clears it (the
 * team's "I fixed it").
 *
 * Called fire-and-forget right after a run finalizes; self-guards on the run's
 * own status so callers stay one-liners. Test runs never count (builder
 * scratch) and never trip it.
 */

/** Reason prefix stamped on `workflows.pausedReason`; the UI splits on ":". */
export const CIRCUIT_BREAKER_REASON_PREFIX = "circuit_breaker";

/**
 * Failure codes where the PLATFORM failed, not the playbook — NEUTRAL for the
 * breaker: they neither count toward nor break the streak. Auto-pausing a
 * healthy workflow during a Trigger/network incident (silently — notification
 * is UI-only) would be worse than letting it retry. Anything not listed here
 * counts, so new playbook-origin codes are breaker-visible by default.
 */
const INFRA_FAILURE_CODES = new Set([
  "STALLED",
  "TRIGGER_FAILED",
  "ORCHESTRATOR_FAILURE",
  "APPROVAL_TIMEOUT",
  "TURN_ERROR",
]);

const isInfraFailure = (error: WorkflowRunError | null): boolean =>
  error !== null && INFRA_FAILURE_CODES.has(error.code);

const maxConsecutiveFailures = (): number => {
  const raw = Number.parseInt(
    process.env["WORKFLOW_MAX_CONSECUTIVE_FAILURES"] ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
};

export const evaluateCircuitBreaker = async (params: {
  runId: string;
}): Promise<void> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { id: params.runId },
    columns: {
      workflowId: true,
      teamId: true,
      status: true,
      isTest: true,
      error: true,
    },
  });
  // Only a real (non-test) run whose PLAYBOOK failed can trip the breaker —
  // an infra-failed run changes nothing since the last evaluation.
  if (!run || run.isTest || run.status !== "failed") return;
  if (isInfraFailure(run.error)) return;

  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { status: true },
  });
  if (!workflow || workflow.status !== "active") return;

  const threshold = maxConsecutiveFailures();
  // Walk the recent terminal, non-test runs newest-first: a succeeded or
  // canceled run BREAKS the streak; an infra-failed run is skipped (neutral);
  // playbook failures count. The scan window is bounded — a streak diluted by
  // heavy infra noise past it simply waits for the next evaluation.
  const recent = await db.query.workflowRuns.findMany({
    where: {
      workflowId: run.workflowId,
      isTest: false,
      status: { in: ["succeeded", "failed", "canceled"] },
    },
    columns: { status: true, error: true },
    orderBy: { createdAt: "desc" },
    limit: threshold * 3,
  });
  let streak = 0;
  for (const r of recent) {
    if (r.status !== "failed") break;
    if (isInfraFailure(r.error)) continue;
    streak += 1;
    if (streak >= threshold) break;
  }
  if (streak < threshold) return;

  await pauseWorkflow({
    id: run.workflowId,
    teamId: run.teamId,
    reason: `${CIRCUIT_BREAKER_REASON_PREFIX}:${String(threshold)}`,
  });
  console.warn(
    `[circuit-breaker] auto-paused workflow ${run.workflowId} after ${String(threshold)} consecutive playbook failures`,
  );
};
