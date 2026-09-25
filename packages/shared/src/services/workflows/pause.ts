import type { Principal } from "../../authz/principal";
import type { WorkflowResponse } from "../../schemas/workflows";
import { deactivateWorkflow } from "./deactivate";

/**
 * Pause a workflow (→ paused): stops firing, drops its schedule. A paused
 * workflow launches NO further runs — cron/event/manual paths all gate on
 * `status='active'`. `reason` records a non-manual cause (the circuit breaker's
 * auto-pause); a plain manual pause omits it, clearing any prior reason.
 */
export const pauseWorkflow = (params: {
  id: string;
  teamId: string;
  reason?: string | null;
  principal: Principal;
}): Promise<WorkflowResponse | undefined> =>
  deactivateWorkflow({ ...params, status: "paused" });
