import { and, eq, lt, or, sql } from "drizzle-orm";
import db from "../../db";
import { releaseTasks } from "../../db/schema";

/**
 * Claiming, and releasing, one task for one version.
 *
 * Everything hard about "run this once per deploy" is in `claim` below, and it
 * is hard for one reason: three services boot from the same image at the same
 * time, each may have several replicas, and any of them can die mid-task. So
 * the claim must be a SINGLE statement — read-then-write would let two
 * processes both find nothing and both proceed.
 */

/**
 * How long a `running` row is believed before it is treated as abandoned.
 *
 * A process that dies mid-task leaves its claim behind, and nothing ever
 * cleans it up: without an expiry, one crash would mean the task never runs
 * again for that version — including on the redeploy somebody does to fix the
 * crash. Thirty minutes is far longer than any task here takes and far shorter
 * than a deployment cycle, so it can only ever free a claim nobody holds.
 */
const STALE_CLAIM_MS = 30 * 60 * 1000;

export interface ClaimedTask {
  id: string;
  /** True when this claim is a retry of a failed or abandoned earlier run. */
  retry: boolean;
}

/**
 * Take the claim, or report that somebody else has it.
 *
 * `on conflict … do update … where` is the whole mechanism. Postgres locks the
 * conflicting row, evaluates the `where` against it, and either updates and
 * returns it or returns nothing — atomically, so two replicas racing produce
 * exactly one winner. The `where` is what makes a task RETRYABLE: a row that
 * ended `failed`, or one still `running` past the staleness window, is up for
 * grabs again; a row that ended `ok` never is.
 *
 * Nothing here throws. A ledger that cannot be reached must not stop a boot —
 * see the runner.
 */
export const claim = async (input: {
  name: string;
  version: string;
  service: string;
}): Promise<ClaimedTask | null> => {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  const rows = await db
    .insert(releaseTasks)
    .values({
      name: input.name,
      version: input.version,
      service: input.service,
      outcome: "running",
      startedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [releaseTasks.name, releaseTasks.version],
      set: {
        outcome: "running",
        service: input.service,
        startedAt: new Date(),
        finishedAt: null,
        durationMs: null,
      },
      where: or(
        eq(releaseTasks.outcome, "failed"),
        and(
          eq(releaseTasks.outcome, "running"),
          lt(releaseTasks.startedAt, staleBefore),
        ),
      ),
    })
    .returning({
      id: releaseTasks.id,
      // `xmax` is 0 on a fresh INSERT and non-zero when the row was UPDATEd —
      // the only way to learn, in one statement, whether this claim created
      // the row or took over an abandoned one. It costs nothing and it is the
      // difference between "first run" and "retrying after a failure", which
      // is what an operator reading the log actually wants to know.
      updated: sql<string>`(xmax <> 0)::text`,
    });

  const row = rows[0];
  return row ? { id: row.id, retry: row.updated === "true" } : null;
};

/** Close a claim. `detail` is whatever the task reported, or its error. */
export const finish = async (input: {
  id: string;
  outcome: "ok" | "failed";
  detail: Record<string, unknown> | null;
  durationMs: number;
}): Promise<void> => {
  await db
    .update(releaseTasks)
    .set({
      outcome: input.outcome,
      detail: input.detail,
      finishedAt: new Date(),
      durationMs: input.durationMs,
    })
    .where(eq(releaseTasks.id, input.id));
};
