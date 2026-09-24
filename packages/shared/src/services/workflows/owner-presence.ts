import { SYSTEM } from "../../authz/system-principals";
import db from "../../db";
import type { Workflow } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import { isTeamMember } from "../team/members";
import { pauseWorkflow } from "./pause";

/**
 * A private workflow runs AS its owner: their memories, their personal
 * connections, their name on everything it writes. So it can only run while
 * that person still belongs to the workflow's team — otherwise someone who
 * left keeps acting inside the team through a schedule nobody sees.
 *
 * Two seams enforce it, because either alone misses a path:
 *   - `assertWorkflowOwnerPresent`, at every run creation (cron, event, form,
 *     manual, builder test): catches every way a person can leave, including
 *     the ones that fire no hook (`/organization/leave`, an organization
 *     delete, a direct row removal);
 *   - `pauseWorkflowsOfDepartedMember`, from the membership hooks: stops the
 *     schedules at once, so the team sees WHY on the workflow instead of
 *     discovering runs that silently never start.
 *
 * Team-shared workflows (`userId` NULL) run as the team's own identity and are
 * untouched.
 */
export const OWNER_GONE_PAUSE_REASON = "owner_gone";

/** Refuse (409) a run of a private workflow whose owner left, pausing it. */
export const assertWorkflowOwnerPresent = async (
  workflow: Pick<Workflow, "id" | "teamId" | "userId">,
): Promise<void> => {
  if (workflow.userId === null) return;
  if (await isTeamMember(workflow.teamId, workflow.userId)) return;

  await pauseWorkflow({
    id: workflow.id,
    teamId: workflow.teamId,
    principal: SYSTEM.workflowEngine,
    reason: OWNER_GONE_PAUSE_REASON,
  });
  return throwHttpError(409, {
    code: ERROR_CODES.WORKFLOW_OWNER_GONE,
    message:
      "This private workflow ran with its owner's access, and they are no longer in the team. It has been paused.",
  });
};

/**
 * Pause every ACTIVE private workflow a departing person owns in the given
 * teams. Sequential on purpose: each pause tears down a Trigger.dev schedule
 * and a queued backlog, and a person owns a handful of workflows, not a bulk.
 */
export const pauseWorkflowsOfDepartedMember = async (params: {
  userId: string;
  teamIds: string[];
}): Promise<number> => {
  if (params.teamIds.length === 0) return 0;

  const owned = await db.query.workflows.findMany({
    columns: { id: true, teamId: true },
    where: {
      userId: params.userId,
      teamId: { in: params.teamIds },
      status: "active",
    },
  });
  for (const workflow of owned) {
    // oxlint-disable-next-line no-await-in-loop -- see the doc comment
    await pauseWorkflow({
      id: workflow.id,
      teamId: workflow.teamId,
      principal: SYSTEM.workflowEngine,
      reason: OWNER_GONE_PAUSE_REASON,
    });
  }
  return owned.length;
};
