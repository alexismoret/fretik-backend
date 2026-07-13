import db from "../../db";
import type { Workflow } from "../../db/schema";

/**
 * Active, event-triggered workflows for the given teams — the match set for
 * one journal-sweep batch. The sweep collects the distinct teams of the batch
 * and pulls their event workflows in one query, then matches each event to
 * them in memory (type + payload filter).
 */
export const listActiveEventWorkflows = async (params: {
  teamIds: string[];
}): Promise<Workflow[]> => {
  if (params.teamIds.length === 0) return [];
  return db.query.workflows.findMany({
    where: {
      status: "active",
      triggerType: "event",
      teamId: { in: params.teamIds },
    },
  });
};
