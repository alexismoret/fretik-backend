import { and, eq } from "drizzle-orm";
import type { Principal } from "../../authz/principal";
import db from "../../db";
import { workflows } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { createWorkflowCronSchedule } from "../../lib/trigger-client";
import { workflowFormActivationError } from "../../schemas/workflow-forms";
import {
  workflowEventActivationError,
  type WorkflowResponse,
} from "../../schemas/workflows";
import { requireWorkflowSettingsAllowed } from "./capabilities";
import { getWorkflowRow } from "./get";
import { serializeWorkflow } from "./serialize";
import { refreshWorkflowVectors } from "./vector-refresh";

/**
 * Activate a workflow (draft/paused → active). For a cron-triggered
 * workflow this creates the Trigger.dev schedule (idempotent by dedup key)
 * and stamps `triggerScheduleId`. Manual / event workflows just flip status.
 * Idempotent: an already-active workflow is returned unchanged. Turning a
 * workflow on is its owner's kind of decision: full access.
 */
export const activateWorkflow = async (params: {
  id: string;
  teamId: string;
  principal: Principal;
}): Promise<WorkflowResponse | undefined> => {
  const row = await getWorkflowRow({ ...params, level: "full" });
  if (!row) return undefined;
  if (row.status === "active") return serializeWorkflow(row);
  // Turning it on is when its settings start to act: all of them are checked
  // against the policy as it stands now, not as it stood when they were set.
  await requireWorkflowSettingsAllowed({
    principal: params.principal,
    teamId: row.teamId,
    after: row,
  });

  let triggerScheduleId = row.triggerScheduleId;
  if (row.triggerType === "cron") {
    const cron = row.triggerConfig.cron;
    if (!cron) {
      return throwHttpError(
        400,
        badRequest("A cron trigger requires a cron pattern in triggerConfig."),
      );
    }
    const created = await createWorkflowCronSchedule({
      workflowId: row.id,
      cron: cron.pattern,
      ...(cron.timezone !== undefined ? { timezone: cron.timezone } : {}),
    });
    triggerScheduleId = created.scheduleId;
  }

  // An event trigger autosaves an empty subscription list while the user is
  // building it. Activating one would be activating into silence, so the
  // completeness gate runs here, next to the cron and form ones.
  if (row.triggerType === "event") {
    const eventError = workflowEventActivationError(row.triggerConfig);
    if (eventError) return throwHttpError(400, badRequest(eventError));
  }

  // A form trigger autosaves incomplete drafts; the completeness gate (title +
  // at least one labelled field, options on every choice field) runs here, at
  // the moment the public URL goes live — mirrors the cron pattern check.
  if (row.triggerType === "form") {
    const form = row.triggerConfig.form;
    if (!form) {
      return throwHttpError(
        400,
        badRequest(
          "A form trigger requires a form definition in triggerConfig.",
        ),
      );
    }
    const formError = workflowFormActivationError(form);
    if (formError) return throwHttpError(400, badRequest(formError));
  }

  const [updated] = await db
    .update(workflows)
    // Clear any auto-pause reason — re-activating is the team's "I fixed it".
    .set({ status: "active", triggerScheduleId, pausedReason: null })
    .where(
      and(eq(workflows.id, params.id), eq(workflows.teamId, params.teamId)),
    )
    .returning();
  if (updated) void refreshWorkflowVectors(updated.id);
  return updated ? serializeWorkflow(updated) : undefined;
};
