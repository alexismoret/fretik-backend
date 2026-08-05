import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflows, type Workflow } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  UpdateWorkflowSchema,
  type UpdateWorkflowInput,
  type WorkflowResponse,
} from "../../schemas/workflows";
import { filterTeamMemberIds } from "../team/members";
import { getWorkflowRow } from "./get";
import { serializeWorkflow } from "./serialize";
import { refreshWorkflowVectors } from "./vector-refresh";
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
  let existingRow: Workflow | undefined;
  if (params.requester) {
    existingRow = await getWorkflowRow({
      id: params.id,
      teamId: params.teamId,
      requester: params.requester,
    });
    if (!existingRow) return undefined;
  }

  // A workflow that becomes a form (or already is one) needs a public token.
  // Reuse the existing token when there is one — the link stays stable across
  // edits — and only mint a fresh one when it's missing.
  let formToken: string | undefined;
  if (input.triggerType === "form") {
    const current =
      existingRow ??
      (await db.query.workflows.findFirst({
        where: { id: params.id, teamId: params.teamId },
        columns: { formToken: true },
      }));
    if (current && !current.formToken) formToken = Bun.randomUUIDv7();
  }

  // Email recipients must be current human team members — silently drop
  // anyone else (stale picker, departed member, bot), same contract as
  // conversation seating. Re-checked again at send time.
  let notifications = input.notifications;
  if (notifications !== undefined) {
    notifications = {
      ...notifications,
      recipientUserIds: await filterTeamMemberIds(
        params.teamId,
        notifications.recipientUserIds,
      ),
    };
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
      ...(input.reasoningLevel !== undefined
        ? { reasoningLevel: input.reasoningLevel }
        : {}),
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
      ...(notifications !== undefined ? { notifications } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(formToken !== undefined ? { formToken } : {}),
    })
    .where(
      and(eq(workflows.id, params.id), eq(workflows.teamId, params.teamId)),
    )
    .returning();

  if (!row) return undefined;
  // The card describes the playbook — re-index whenever it changes.
  void refreshWorkflowVectors(row.id);
  return serializeWorkflow(row);
};
