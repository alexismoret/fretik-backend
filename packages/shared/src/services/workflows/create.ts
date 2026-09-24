import { restrictionColumns } from "../../authz/legacy-privacy";
import type { Principal } from "../../authz/principal";
import db from "../../db";
import { workflows } from "../../db/schema";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import {
  CreateWorkflowSchema,
  type CreateWorkflowInput,
  type WorkflowResponse,
} from "../../schemas/workflows";
import { requireWorkflowSettingsAllowed } from "./capabilities";
import { serializeWorkflow } from "./serialize";
import { validateWorkflowExternalApps } from "./validate-external-apps";
import { refreshWorkflowVectors } from "./vector-refresh";

/**
 * Create a workflow definition (always `status: "draft"` — activation is a
 * separate, gated step). The creator owns it. The legacy `userId` says who
 * sees it: null opens it to the team (it then runs as the team's agent), the
 * creator's own id restricts it to them (it then runs with their access) —
 * never someone else's, which would make it act as them.
 */
export const createWorkflow = async (params: {
  organizationId: string;
  teamId: string;
  /** The project it is made in; null or omitted for its team's. */
  projectId?: string | null;
  createdByUserId: string;
  /** The creator, as the engine sees them (bounds the connections it names). */
  principal: Principal;
  input: CreateWorkflowInput;
}): Promise<WorkflowResponse> => {
  const input = CreateWorkflowSchema.parse(params.input);

  const restricted = input.userId !== undefined && input.userId !== null;
  if (restricted && input.userId !== params.createdByUserId) {
    return throwHttpError(
      400,
      badRequest(
        "workflow.userId can only be null (the team's) or your own id. A workflow never runs as someone else.",
      ),
    );
  }
  const access = restrictionColumns({
    restricted,
    ownerUserId: params.createdByUserId,
  });
  await requireWorkflowSettingsAllowed({
    principal: params.principal,
    teamId: params.teamId,
    after: input,
  });

  const externalAppConnectionIds =
    input.externalAppConnectionIds === undefined
      ? []
      : await validateWorkflowExternalApps({
          connectionIds: input.externalAppConnectionIds,
          teamId: params.teamId,
          runsAsUserId: access.userId,
          actor: params.principal,
        });

  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      projectId: params.projectId ?? null,
      ...access,
      name: input.name,
      description: input.description,
      icon: input.icon ?? null,
      color: input.color ?? null,
      status: "draft",
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig,
      // A form workflow needs an opaque token to key its public URL from the
      // moment it exists (the builder shows the link before activation).
      ...(input.triggerType === "form"
        ? { formToken: Bun.randomUUIDv7() }
        : {}),
      playbook: input.playbook,
      autonomy: input.autonomy,
      modelProfileKey: input.modelProfileKey ?? null,
      reasoningLevel: input.reasoningLevel ?? null,
      limits: input.limits,
      externalAppConnectionIds,
      createdByUserId: params.createdByUserId,
    })
    .returning();

  if (!row) return throwHttpError(500, internalError());
  // Index it so the assistant can find it later from a plain request.
  void refreshWorkflowVectors(row.id);
  return serializeWorkflow(row);
};
