import db from "../../db";
import { workflows } from "../../db/schema";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import {
  CreateWorkflowSchema,
  type CreateWorkflowInput,
  type WorkflowResponse,
} from "../../schemas/workflows";
import { serializeWorkflow } from "./serialize";
import { workflowOwnerWriteError } from "./visibility";

/**
 * Create a workflow definition (always `status: "draft"` — activation is a
 * separate, gated step). Scoped to the caller's team/org; `userId` set =
 * private to that user, null = team-shared. `userId` can only be omitted/null
 * or the creator's own id — nobody can scope a workflow to run as someone
 * else (see `workflowOwnerWriteError`).
 */
export const createWorkflow = async (params: {
  organizationId: string;
  teamId: string;
  createdByUserId: string;
  input: CreateWorkflowInput;
}): Promise<WorkflowResponse> => {
  const input = CreateWorkflowSchema.parse(params.input);

  const ownerError = workflowOwnerWriteError(
    input.userId ?? null,
    params.createdByUserId,
  );
  if (ownerError) return throwHttpError(400, badRequest(ownerError));

  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: input.userId ?? null,
      name: input.name,
      description: input.description,
      icon: input.icon ?? null,
      color: input.color ?? null,
      status: "draft",
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig,
      playbook: input.playbook,
      autonomy: input.autonomy,
      modelProfileKey: input.modelProfileKey ?? null,
      limits: input.limits,
      createdByUserId: params.createdByUserId,
    })
    .returning();

  if (!row) return throwHttpError(500, internalError());
  return serializeWorkflow(row);
};
