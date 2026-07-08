import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflows } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  UpdateWorkflowSchema,
  type UpdateWorkflowInput,
  type WorkflowResponse,
} from "../../schemas/workflows";
import { getWorkflowRow } from "./get";
import { serializeWorkflow } from "./serialize";
import { workflowOwnerWriteError, type WorkflowRequester } from "./visibility";

/**
 * Update a workflow definition (partial). Team-scoped, and restricted to
 * workflows the requester can see (a private workflow is invisible — and
 * thus unmutable — to anyone but its owner, admins excepted). Only the
 * provided fields are written. `userId` (re-scope) can only be set to null
 * or the requester's own id. Trigger-schedule re-sync on cron changes is
 * owned by the activate/pause path — editing config while active does not
 * silently re-schedule (the user re-activates to apply).
 */
export const updateWorkflow = async (params: {
  id: string;
  teamId: string;
  input: UpdateWorkflowInput;
  requester?: WorkflowRequester;
}): Promise<WorkflowResponse | undefined> => {
  const input = UpdateWorkflowSchema.parse(params.input);

  if (input.userId !== undefined && params.requester) {
    const ownerError = workflowOwnerWriteError(
      input.userId,
      params.requester.userId,
    );
    if (ownerError) return throwHttpError(400, badRequest(ownerError));
  }

  // Visible-but-not-mutable-by-id-alone: reuse the same visibility predicate
  // as reads so a private workflow can't be patched by guessing its id.
  if (params.requester) {
    const visible = await getWorkflowRow({
      id: params.id,
      teamId: params.teamId,
      requester: params.requester,
    });
    if (!visible) return undefined;
  }

  const [row] = await db
    .update(workflows)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.triggerType !== undefined
        ? { triggerType: input.triggerType }
        : {}),
      ...(input.triggerConfig !== undefined
        ? { triggerConfig: input.triggerConfig }
        : {}),
      ...(input.playbook !== undefined ? { playbook: input.playbook } : {}),
      ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
      ...(input.modelProfileKey !== undefined
        ? { modelProfileKey: input.modelProfileKey }
        : {}),
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
    })
    .where(
      and(eq(workflows.id, params.id), eq(workflows.teamId, params.teamId)),
    )
    .returning();

  if (!row) return undefined;
  return serializeWorkflow(row);
};
