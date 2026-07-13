import db from "../../db";
import type { DashboardAttentionResponse } from "../../schemas/dashboard";
import { workflowVisibilityWhere } from "../workflows/visibility";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 8;

/**
 * The home "Needs your attention" inbox — the workflow runs waiting on the
 * user: those paused for an approval, then those that failed in the last week.
 * Private workflows are hidden from non-owners via the shared visibility
 * predicate, so a teammate's private run never surfaces here. Approvals lead
 * (they block a run right now); recent failures follow. Capped to keep the
 * card scannable — `count` reflects the number surfaced.
 */
export const getDashboardAttention = async (data: {
  teamId: string;
  userId: string;
}): Promise<DashboardAttentionResponse> => {
  const { teamId, userId } = data;
  const since7 = new Date(Date.now() - 7 * DAY_MS);
  const visibility = workflowVisibilityWhere({ userId, isAdmin: false });

  const [approvals, failures] = await Promise.all([
    db.query.workflowRuns.findMany({
      where: { teamId, status: "needs_approval", workflow: visibility },
      orderBy: { createdAt: "desc" },
      limit: MAX_ITEMS,
      columns: { id: true, workflowId: true, updatedAt: true },
      with: { workflow: { columns: { name: true } } },
    }),
    db.query.workflowRuns.findMany({
      where: {
        teamId,
        status: "failed",
        createdAt: { gte: since7 },
        workflow: visibility,
      },
      orderBy: { createdAt: "desc" },
      limit: MAX_ITEMS,
      columns: {
        id: true,
        workflowId: true,
        updatedAt: true,
        finishedAt: true,
      },
      with: { workflow: { columns: { name: true } } },
    }),
  ]);

  const items: DashboardAttentionResponse["items"] = [
    ...approvals.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      kind: "approval" as const,
      title: r.workflow?.name ?? "",
      // While paused for approval the run isn't heartbeating, so its last
      // update ≈ the moment it asked for one.
      at: r.updatedAt,
    })),
    ...failures.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      kind: "error" as const,
      title: r.workflow?.name ?? "",
      at: r.finishedAt ?? r.updatedAt,
    })),
  ].slice(0, MAX_ITEMS);

  return { count: items.length, items };
};
