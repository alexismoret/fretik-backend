import type { WorkflowResponse } from "../../schemas/workflows";
import { deactivateWorkflow } from "./deactivate";
import type { WorkflowRequester } from "./visibility";

/** Archive a workflow (→ archived): stops firing, drops its schedule, and
 * hides it from the default list. */
export const archiveWorkflow = (params: {
  id: string;
  teamId: string;
  requester?: WorkflowRequester;
}): Promise<WorkflowResponse | undefined> =>
  deactivateWorkflow({ ...params, status: "archived" });
