import { and, eq } from "drizzle-orm";
import { resolveAccess } from "../../authz/access";
import { restrictionColumns } from "../../authz/legacy-privacy";
import { atLeast } from "../../authz/levels";
import type { Principal } from "../../authz/principal";
import db from "../../db";
import { workflows } from "../../db/schema";
import { badRequest, forbidden, throwHttpError } from "../../lib/errors";
import {
  liveTriggerCompletenessError,
  UpdateWorkflowSchema,
  type UpdateWorkflowInput,
  type WorkflowResponse,
} from "../../schemas/workflows";
import { recordAccessEvent } from "../access/record-event";
import { refreshAclsAfterAccessChange } from "../ai-vectors/acl";
import { resyncVectorUserScope } from "../ai-vectors/resync-user-scope";
import { filterTeamMemberIds } from "../team/members";
import { requireWorkflowSettingsAllowed } from "./capabilities";
import { getWorkflowRow } from "./get";
import { serializeWorkflow } from "./serialize";
import { validateWorkflowExternalApps } from "./validate-external-apps";
import { refreshWorkflowVectors } from "./vector-refresh";

/**
 * Update a workflow definition (partial). Only the provided fields are
 * written; the workflow must be one the principal reaches at `edit`
 * (`visibility.ts`), and re-scoping it (`userId`) is decided by
 * `decideRestriction` below. Trigger-schedule re-sync on cron changes is owned
 * by the activate/pause path — editing config while active does not silently
 * re-schedule (the user re-activates to apply).
 */
export const updateWorkflow = async (params: {
  id: string;
  teamId: string;
  input: UpdateWorkflowInput;
  principal: Principal;
}): Promise<WorkflowResponse | undefined> => {
  const input = UpdateWorkflowSchema.parse(params.input);

  const existingRow = await getWorkflowRow({
    id: params.id,
    teamId: params.teamId,
    principal: params.principal,
    level: "edit",
  });
  if (!existingRow) return undefined;

  const owner =
    existingRow.ownerUserId ??
    existingRow.userId ??
    existingRow.createdByUserId;
  const restriction =
    input.userId === undefined
      ? undefined
      : await decideRestriction({
          principal: params.principal,
          workflowId: existingRow.id,
          requestedUserId: input.userId,
          ownerUserId: owner,
        });

  // Scope and declared apps constrain each other, so a patch touching EITHER
  // is re-checked against the other side as stored. Re-scoping to team-shared
  // while a personal connection is declared is the case that matters: the
  // workflow would start running as the team bot, which cannot resolve it.
  let externalAppConnectionIds: string[] | undefined;
  if (
    input.externalAppConnectionIds !== undefined ||
    input.userId !== undefined
  ) {
    const runsAs =
      restriction === undefined
        ? existingRow.userId
        : restrictionColumns(restriction).userId;
    const ids =
      input.externalAppConnectionIds ?? existingRow.externalAppConnectionIds;
    const validated = await validateWorkflowExternalApps({
      connectionIds: ids,
      teamId: params.teamId,
      runsAsUserId: runsAs,
      actor: params.principal,
    });
    // Only WRITE the list when the patch actually carried one — a re-scope
    // validates the stored list, it does not rewrite it.
    if (input.externalAppConnectionIds !== undefined) {
      externalAppConnectionIds = validated;
    }
  }

  // Editing the trigger of an ALREADY-ACTIVE workflow never passes through
  // `activateWorkflow` (it returns early on `status === "active"`), so the
  // three completeness gates that live there — cron pattern, ≥1 event
  // subscription, form fields — were unreachable on this path. An event
  // config emptied here left the workflow displayed as active while
  // subscribed to nothing: `eventSubscriptions()` returns `[]`, `matchesEvent`
  // runs `.some()` over it, and the workflow goes permanently silent with no
  // error, no log and no `pausedReason`. Autosave-incomplete stays legal on a
  // draft or a paused workflow; what is refused is making a LIVE workflow
  // unreachable.
  if (input.triggerType !== undefined || input.triggerConfig !== undefined) {
    const current = existingRow;
    if (current.status === "active") {
      const nextType = input.triggerType ?? current.triggerType;
      const nextConfig = input.triggerConfig ?? current.triggerConfig;
      const completenessError = liveTriggerCompletenessError(
        nextType,
        nextConfig,
      );
      if (completenessError) {
        return throwHttpError(400, badRequest(completenessError));
      }
    }
  }

  // Acting without approvals and a public form are the team's call: the patch
  // may set them only for someone the policy lets (`capabilities.ts`).
  await requireWorkflowSettingsAllowed({
    principal: params.principal,
    teamId: params.teamId,
    before: existingRow,
    after: {
      autonomy: input.autonomy ?? existingRow.autonomy,
      triggerType: input.triggerType ?? existingRow.triggerType,
      triggerConfig: input.triggerConfig ?? existingRow.triggerConfig,
    },
  });

  // A workflow that becomes a form (or already is one) needs a public token.
  // Reuse the existing token when there is one — the link stays stable across
  // edits — and only mint a fresh one when it's missing.
  let formToken: string | undefined;
  if (input.triggerType === "form") {
    if (!existingRow.formToken) formToken = Bun.randomUUIDv7();
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

  // One transaction, because a scope change has to move the workflow row and
  // its vectors' `user_id` together — see `resyncVectorUserScope`.
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
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
        ...(externalAppConnectionIds !== undefined
          ? { externalAppConnectionIds }
          : {}),
        ...(restriction === undefined ? {} : restrictionColumns(restriction)),
        ...(formToken !== undefined ? { formToken } : {}),
      })
      .where(
        and(eq(workflows.id, params.id), eq(workflows.teamId, params.teamId)),
      )
      .returning();

    if (!updated) return undefined;

    // Visibility moves NOW, inside the transaction. The async refresh below
    // rewrites the card text, but it swallows its own errors, so a dropped
    // refresh would leave a privatised workflow readable by the whole team
    // until someone saved it again. One indexed UPDATE, no embedding.
    if (restriction !== undefined) {
      await resyncVectorUserScope({
        sourceType: "workflows",
        sourceId: updated.id,
        userId: updated.userId,
        tx,
      });
      await refreshAclsAfterAccessChange({
        executor: tx,
        type: "workflow",
        id: updated.id,
      });
      const wasRestricted =
        existingRow.accessRestricted || existingRow.userId !== null;
      if (wasRestricted !== restriction.restricted) {
        await recordAccessEvent({
          executor: tx,
          organizationId: updated.organizationId,
          actorUserId:
            params.principal.kind === "user" ? params.principal.userId : null,
          action: "restriction.changed",
          resource: { type: "workflow", id: updated.id },
          metadata: {
            restricted: restriction.restricted,
            resourceName: updated.name,
          },
        });
      }
    }
    return updated;
  });

  if (!row) return undefined;
  // The card describes the playbook — re-index whenever it changes.
  void refreshWorkflowVectors(row.id);
  return serializeWorkflow(row);
};

/**
 * Decide a legacy `userId` write — who sees the workflow, and so whose access
 * it runs with. Opening it to the team (null) is sharing: full access, and it
 * then runs as the team's agent. Restricting it makes it run WITH ITS OWNER'S
 * ACCESS, so only the owner may do that — anyone else would be making it act
 * as someone who never agreed to. A workflow with no owner left is taken over
 * by the person who restricts it.
 */
const decideRestriction = async (input: {
  principal: Principal;
  workflowId: string;
  requestedUserId: string | null;
  ownerUserId: string | null;
}): Promise<{ restricted: boolean; ownerUserId: string | null }> => {
  const { principal } = input;
  if (input.requestedUserId === null) {
    const resolved =
      principal.kind === "system"
        ? { level: "full" as const }
        : await resolveAccess(principal, "workflow", input.workflowId);
    if (!resolved || !atLeast(resolved.level, "full")) {
      return throwHttpError(
        403,
        forbidden("Opening this workflow to the team takes full access"),
      );
    }
    return { restricted: false, ownerUserId: input.ownerUserId };
  }

  if (principal.kind === "user") {
    const ownsIt =
      input.ownerUserId === null || input.ownerUserId === principal.userId;
    if (!ownsIt || input.requestedUserId !== principal.userId) {
      return throwHttpError(
        400,
        badRequest(
          "workflow.userId can only be null (the team's, run by the team's agent) or your own id on a workflow you own. A workflow never runs as someone else.",
        ),
      );
    }
  }
  return {
    restricted: true,
    ownerUserId: input.ownerUserId ?? input.requestedUserId,
  };
};
