import type { Principal } from "../../authz/principal";
import type { WorkflowResponse } from "../../schemas/workflows";
import { deactivateWorkflow } from "./deactivate";

/** Archive a workflow (→ archived): stops firing, drops its schedule, and
 * hides it from the default list. */
export const archiveWorkflow = (params: {
  id: string;
  teamId: string;
  principal: Principal;
}): Promise<WorkflowResponse | undefined> =>
  deactivateWorkflow({ ...params, status: "archived" });
