import { WORKFLOW_CRON_TASK_ID } from "@fretik/shared/schemas/workflows";
import { logger, schedules } from "@trigger.dev/sdk";

/**
 * The shared cron proxy — ONE scheduled task serves every cron-triggered
 * workflow. Activating a workflow attaches a dynamic schedule
 * (`schedules.create({ externalId: workflowId, deduplicationKey })`, see
 * `@fretik/shared/lib/trigger-client.ts`); each firing simply asks the AI
 * service to fire a run through the single creation seam, which re-checks
 * that the workflow is still active and skips when a run is already in
 * flight. A dangling schedule after a pause is therefore harmless.
 */
export const workflowCron = schedules.task({
  id: WORKFLOW_CRON_TASK_ID,
  machine: "micro",
  run: async (payload) => {
    const workflowId = payload.externalId;
    if (workflowId === undefined) {
      logger.warn("cron fired without externalId — skipping");
      return { fired: false };
    }
    const base = process.env.FRETIK_AI_URL;
    const key = process.env.TRIGGER_CALLBACK_KEY;
    if (base === undefined || base === "" || key === undefined || key === "") {
      throw new Error(
        "FRETIK_AI_URL / TRIGGER_CALLBACK_KEY are not set on this Trigger.dev environment",
      );
    }
    const response = await fetch(
      `${base}/internal/trigger/workflows/${workflowId}/cron-fire`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Trigger-Key": key },
        body: JSON.stringify({ scheduledAt: payload.timestamp }),
      },
    );
    if (!response.ok) {
      throw new Error(`cron-fire → HTTP ${response.status.toString()}`);
    }
    return response.json();
  },
});
