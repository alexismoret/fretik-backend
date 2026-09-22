import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { cancelWorkflowTriggerRun } from "../../lib/trigger-client";
import { WORKFLOW_MAX_DURATION_MINUTES } from "../../schemas/workflows";

/**
 * Convert the runs parked by the OLD orchestrator — the one that sat in
 * `wait.forToken` — to the resume-point scheme. A one-shot migration of
 * live state, driven by `scripts/convert-legacy-approval-parks.ts`.
 *
 * Why they exist: self-hosted Trigger.dev has no checkpoints, so an
 * orchestrator waiting on an approval stays EXECUTING and holds its
 * workflow's per-workflow concurrency slot. Three of them at a limit of
 * three silenced a live workflow for six days (2026-09-15 → 09-21) with four
 * runs queued behind it. The orchestrator now ends at the park instead;
 * these rows predate that and still have a live process holding a slot.
 *
 * Per run: cancel the Trigger run — the only thing that releases a parked
 * orchestrator, since completing its token would instead resume the playbook
 * on the old code — then write the resume point, so answering the approval
 * starts a fresh orchestrator under the new scheme.
 *
 * IT NEVER READS `wait_token_id`, on purpose. A parked run with no resume
 * point IS a legacy park, and the cancel goes through `trigger_run_id`. That
 * is what lets the column and the `/wait-token` route be dropped in the same
 * release as this code, rather than carried until every old park ages out.
 */

/**
 * A park younger than this is not touched.
 *
 * The candidate predicate — parked, no resume point — also matches, for a
 * fraction of a second, a run under the NEW code: the turn's transaction
 * writes `needs_approval` and `paused_at` before the orchestrator's `/park`
 * callback lands. Cancelling one of those would kill a healthy orchestrator
 * that was about to park itself. A genuine legacy park is days old, so the
 * two populations separate trivially by age — and erring wide is free,
 * because a row skipped now is converted by the next run.
 */
export const MIN_PARK_AGE_MINUTES = 15;

export interface LegacyParkConversion {
  runId: string;
  workflowName: string;
  pausedAt: Date | null;
  triggerRunId: string | null;
  resumeFromTurnIndex: number;
  remainingMs: number;
  /** Only set on `apply`. */
  converted?: boolean;
  /** Only set when the cancel call failed; the row is converted regardless. */
  cancelError?: string;
}

/** The budget a resumed orchestrator gets, in ms.
 *
 * RECONSTRUCTED, not carried: these rows were parked by code that kept the
 * deadline in the orchestrator's MEMORY, and that memory is what the cancel
 * throws away. Worked time is `pausedAt - startedAt` minus the parks already
 * closed (`pausedMs`) — the same subtraction every duration read in the
 * product makes. The new scheme carries the real figure through the park, so
 * this approximation only ever applies to the handful of rows converted once.
 */
export const reconstructRemainingMs = (row: {
  startedAt: Date | null;
  pausedAt: Date | null;
  pausedMs: number;
  maxDurationMinutes: number;
}): number => {
  const budgetMs = row.maxDurationMinutes * 60_000;
  if (row.startedAt === null || row.pausedAt === null) return budgetMs;
  const workedMs =
    row.pausedAt.getTime() - row.startedAt.getTime() - row.pausedMs;
  // A negative worked time can only come from a clock skew, and must never
  // turn into a budget LARGER than the workflow's own.
  return Math.max(Math.min(budgetMs - Math.max(workedMs, 0), budgetMs), 0);
};

export const convertLegacyApprovalParks = async (params: {
  /** False lists what would change and writes nothing. */
  apply: boolean;
  now?: Date;
}): Promise<LegacyParkConversion[]> => {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - MIN_PARK_AGE_MINUTES * 60_000);

  const candidates = await db.query.workflowRuns.findMany({
    where: {
      status: "needs_approval",
      resumeFromTurnIndex: { isNull: true },
      pausedAt: { lt: cutoff },
    },
    columns: {
      id: true,
      triggerRunId: true,
      lastTurnIndex: true,
      startedAt: true,
      pausedAt: true,
      pausedMs: true,
    },
    with: { workflow: { columns: { name: true, limits: true } } },
  });

  const report: LegacyParkConversion[] = [];

  for (const row of candidates) {
    // The relation is typed nullable although the FK is not; fall back rather
    // than crash the whole conversion on one odd row.
    const maxDurationMinutes =
      row.workflow?.limits.maxDurationMinutes ?? WORKFLOW_MAX_DURATION_MINUTES;
    const remainingMs = reconstructRemainingMs({
      startedAt: row.startedAt,
      pausedAt: row.pausedAt,
      pausedMs: row.pausedMs,
      maxDurationMinutes,
    });
    // The run stopped at `lastTurnIndex`; the approval's outcome is read by
    // the turn AFTER it — the same arithmetic the orchestrator now does.
    const resumeFromTurnIndex = row.lastTurnIndex + 1;

    const entry: LegacyParkConversion = {
      runId: row.id,
      workflowName: row.workflow?.name ?? "(workflow missing)",
      pausedAt: row.pausedAt,
      triggerRunId: row.triggerRunId,
      resumeFromTurnIndex,
      remainingMs,
    };

    if (!params.apply) {
      report.push(entry);
      continue;
    }

    // Cancel FIRST — the slot is only released when the process dies, and the
    // resume point must not be readable while an orchestrator could still be
    // woken by a token we can no longer see.
    if (row.triggerRunId !== null) {
      try {
        await cancelWorkflowTriggerRun(row.triggerRunId);
      } catch (error) {
        // A run Trigger no longer knows about holds no slot, which is the
        // outcome wanted. Record it and convert anyway.
        entry.cancelError =
          error instanceof Error ? error.message : String(error);
      }
    }

    // Write the resume point AND force the row back to `needs_approval`.
    // The forcing is deliberate: cancellation has its own lifecycle
    // (`onCancel`, which this codebase does not define) and should not reach
    // the task's `onFailure` — but the SDK docs never say so outright, and if
    // it did fire it would have POSTed /finalize and closed this run
    // `failed`. Repair whatever the cancel left rather than bet on the hook.
    //
    // `resume_from_turn_index IS NULL` is the idempotency guard: only this
    // conversion fills it, so a second pass is a no-op.
    const repaired = await db
      .update(workflowRuns)
      .set({
        status: "needs_approval",
        resumeFromTurnIndex,
        resumeRemainingMs: remainingMs,
        triggerRunId: null,
        finishedAt: null,
        error: null,
      })
      .where(
        and(
          eq(workflowRuns.id, row.id),
          isNull(workflowRuns.resumeFromTurnIndex),
        ),
      )
      .returning({ id: workflowRuns.id });

    entry.converted = repaired.length > 0;
    report.push(entry);
  }

  return report;
};
