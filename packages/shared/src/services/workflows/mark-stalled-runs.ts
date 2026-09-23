import { and, eq, lt, or, sql } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { finalizeRun } from "./finalize-run";
import { onWorkflowRunTerminal } from "./on-run-terminal";
import { sendRunCompletionEmailIfEnabled } from "./send-run-completion-email";

/** A run is stalled if it's still `running` but hasn't beaten in this long. */
export const WORKFLOW_STALL_MINUTES = 20;

/** A `queued` run older than the Trigger.dev queue TTL (7d) + slack never
 * started and never will — Trigger expired or lost it. */
const QUEUED_EXPIRY_MS = (7 * 24 + 12) * 60 * 60 * 1000;

/**
 * How long an approval may sit unanswered before its run is closed.
 *
 * This used to be the `timeout` on the Trigger.dev wait token the
 * orchestrator parked in. That park is gone — self-hosted Trigger.dev cannot
 * checkpoint, so waiting there held the workflow's concurrency slot — and
 * with it went the only bound on a forgotten approval. Enforcing it here is
 * not tidying: without it a parked run waits forever.
 */
export const WORKFLOW_APPROVAL_TIMEOUT_MINUTES = 7 * 24 * 60;

/**
 * Reclaim zombie runs — ones stuck in `running` whose Trigger.dev
 * orchestrator crashed (no heartbeat for `WORKFLOW_STALL_MINUTES`). Marks
 * them `failed(STALLED)` so the UI stops showing an eternal spinner and the
 * per-workflow concurrency slot frees up.
 *
 * CRUCIAL: the heartbeat check considers only `status = 'running'` rows.
 * Runs in `needs_approval` are excluded from IT — they are legitimately
 * parked with a necessarily stale heartbeat (there is no orchestrator at all
 * while a run waits on a human) and must never be killed for waiting. They
 * are bounded instead by their own, far longer clock, below.
 *
 * Also closes approvals nobody answered within
 * `WORKFLOW_APPROVAL_TIMEOUT_MINUTES`. That deadline used to live on the
 * Trigger.dev wait token and disappeared with it, so this is now the ONLY
 * thing standing between a forgotten approval and a run parked forever.
 *
 * Also reclaims `queued` zombies: a run older than the Trigger.dev queue TTL
 * that never started (Trigger expired or lost it) is closed
 * `failed(EXPIRED)` so it doesn't sit as an eternal "queued" row. `queued`
 * within the TTL is a NORMAL state — a bulk-upload backlog draining at the
 * per-workflow concurrency waits exactly there.
 *
 * Each candidate is closed through `finalizeRun` (per-run — the set is
 * normally empty and bounded by crashed orchestrators, not a bulk path), so
 * this terminal path journals `workflow.run.completed` and notifies like
 * every other one; finalizeRun's atomic guard arbitrates concurrent sweeps.
 *
 * Belt-and-suspenders behind the orchestrator's own `onFailure` finalize;
 * run periodically by the jobs maintenance sweep. Returns the count reclaimed.
 */
export const markStalledRuns = async (params?: {
  now?: Date;
}): Promise<number> => {
  const now = params?.now ?? new Date();
  const cutoff = new Date(now.getTime() - WORKFLOW_STALL_MINUTES * 60_000);

  const stalled = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        or(
          lt(workflowRuns.lastHeartbeatAt, cutoff),
          // A run that reached `running` but somehow never stamped a
          // heartbeat (crash right after start) is caught via startedAt.
          and(
            sql`${workflowRuns.lastHeartbeatAt} IS NULL`,
            lt(workflowRuns.startedAt, cutoff),
          ),
        ),
      ),
    );

  const queuedCutoff = new Date(now.getTime() - QUEUED_EXPIRY_MS);
  const expired = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "queued"),
        lt(workflowRuns.createdAt, queuedCutoff),
      ),
    );

  // A park nobody answered. `pausedAt` is stamped by the turn that asked
  // (`recordTurnResult`), so it is the age of the QUESTION, not of the run —
  // which is what the deadline is about. A row with `pausedAt IS NULL` is
  // excluded by `lt` on its own, so a `needs_approval` row that somehow
  // never stamped one is left alone rather than killed on sight.
  const approvalCutoff = new Date(
    now.getTime() - WORKFLOW_APPROVAL_TIMEOUT_MINUTES * 60_000,
  );
  const unanswered = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "needs_approval"),
        lt(workflowRuns.pausedAt, approvalCutoff),
      ),
    );

  const candidates = [
    ...stalled.map((row) => ({
      id: row.id,
      error: {
        code: "STALLED",
        message: `No heartbeat for ${WORKFLOW_STALL_MINUTES.toString()} min, so the run was reclaimed.`,
      },
    })),
    ...expired.map((row) => ({
      id: row.id,
      error: {
        code: "EXPIRED",
        message: "Queued longer than the queue TTL, so the run never started.",
      },
    })),
    ...unanswered.map((row) => ({
      id: row.id,
      error: {
        code: "APPROVAL_TIMEOUT",
        message: "The approval request expired unanswered.",
      },
    })),
  ];

  let reclaimed = 0;
  for (const candidate of candidates) {
    const { transitioned } = await finalizeRun({
      runId: candidate.id,
      status: "failed",
      error: candidate.error,
      now,
    });
    if (!transitioned) continue;
    reclaimed += 1;
    void sendRunCompletionEmailIfEnabled({ runId: candidate.id }).catch(
      (err: unknown) => {
        console.warn(
          `[workflow-run ${candidate.id}] completion email failed:`,
          err,
        );
      },
    );
    // A reclaimed run has no live turn to tell its launching chat — do it here.
    void onWorkflowRunTerminal({ runId: candidate.id }).catch(
      (err: unknown) => {
        console.warn(
          `[workflow-run ${candidate.id}] source-conversation notice failed:`,
          err,
        );
      },
    );
  }

  return reclaimed;
};
