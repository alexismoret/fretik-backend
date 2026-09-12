import { eq } from "drizzle-orm";
import db from "../../db";
import { workflows, type ExternalAppConnection } from "../../db/schema";
import { WORKFLOW_MAX_EXTERNAL_APPS } from "../../schemas/workflows";
import type { WorkflowRunContext } from "./run-context";

/** Just enough of a resolved connection to decide, without re-reading it. */
export type ObservedConnection = Pick<ExternalAppConnection, "id" | "userId">;

/**
 * Whether the WORKFLOW — not the run's actor — could open this connection.
 *
 * The same predicate `validateWorkflowExternalApps` applies at write time, so
 * observation can never write a list the author would then be unable to save.
 * It matters in exactly one case: a team workflow runs as the team bot, and a
 * connection personal to that bot resolves for the run yet is `unreachable` for
 * a `null`-owner workflow. Rare, and cheap to exclude here since the caller
 * already holds the row.
 */
const reachableByWorkflow = (
  run: WorkflowRunContext,
  connection: ObservedConnection,
): boolean =>
  connection.userId === null || connection.userId === run.ownerUserId;

/**
 * Fold the connections a run actually resolved into the workflow's declared
 * list — the reason that list stops being a form somebody has to keep current.
 *
 * Declaring apps by hand only ever helped BEFORE the first run (it is what
 * makes the private-app/team-scope gate answerable on a brand-new workflow).
 * Afterwards the runs know better than the author: this appends what they
 * touched, so the list converges on the truth without anyone maintaining it.
 *
 *  - **Append-only, order preserving.** What the author declared stays first
 *    and stays put; observations land at the end. Removing an app that the
 *    workflow really does use is therefore not permanent — the next run that
 *    opens it puts it back, which is the right answer for a field that claims
 *    to describe what the workflow uses.
 *  - **Capped** at `WORKFLOW_MAX_EXTERNAL_APPS`, the same ceiling the request
 *    schema enforces. A list grown past it could never be saved again from the
 *    UI, so a run stops adding rather than write a row the author can't edit.
 *  - **Never fatal.** Bookkeeping runs on the path of a live third-party call;
 *    a failure here is logged and swallowed, never turned into a tool error the
 *    agent has to reason about.
 *
 * The fast path — every observed id already declared — costs nothing: the
 * caller passes the list it already read with the run context, so a workflow in
 * steady state does no extra query at all.
 */
export const recordWorkflowExternalApps = async (
  run: WorkflowRunContext,
  connections: readonly ObservedConnection[],
): Promise<void> => {
  const known = new Set(run.externalAppConnectionIds);
  const fresh = [
    ...new Set(
      connections
        .filter((c) => !known.has(c.id) && reachableByWorkflow(run, c))
        .map((c) => c.id),
    ),
  ];
  if (fresh.length === 0) return;

  try {
    await db.transaction(async (tx) => {
      // Re-read under the row lock: two ops of the same plan can resolve two
      // different apps at once, and a read-modify-write on the snapshot each
      // one started from would keep whichever committed last.
      const [current] = await tx
        .select({ ids: workflows.externalAppConnectionIds })
        .from(workflows)
        .where(eq(workflows.id, run.workflowId))
        .for("update");
      if (!current) return;

      const next = [...current.ids];
      for (const id of fresh) {
        if (next.length >= WORKFLOW_MAX_EXTERNAL_APPS) break;
        if (!next.includes(id)) next.push(id);
      }
      if (next.length === current.ids.length) return;

      await tx
        .update(workflows)
        .set({ externalAppConnectionIds: next })
        .where(eq(workflows.id, run.workflowId));
    });
  } catch (error) {
    console.warn(
      `[workflows] could not record external app usage on workflow ${run.workflowId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
