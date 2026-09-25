import { requireAccess } from "@fretik/shared/authz/access";
import {
  type DriveAction,
  requireDriveAction,
} from "@fretik/shared/authz/drive";
import { requireCapability } from "@fretik/shared/authz/gates";
import {
  type Placement,
  requirePlacement,
} from "@fretik/shared/authz/placement";
import type { AccessLevel, CapabilityKey } from "@fretik/shared/schemas/access";
import { actingPrincipal } from "./acting-principal";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * What a tool asks before it changes anything, for whoever the turn acts for
 * (`actingPrincipal`) — the same questions the API's routes ask the person in
 * the app, so the assistant can do nothing its user could not.
 *
 * Asked BEFORE any approval is opened: an approval for a write that could not
 * run is a question nobody should be asked. The approvals that apply a write
 * later ask again (`@fretik/shared/services/tool-policies/builtin-apply`),
 * since access can change while one waits. A refusal is thrown: the tool
 * wrapper hands it to the model as the refusal it is (`liftAccessRefusal`).
 */

type TurnScope = Pick<
  AgentRuntimeContext,
  "organizationId" | "teamId" | "userId" | "projectId"
>;

/** A capability, decided in the turn's team. */
export const requireTurnCapability = async (
  ctx: TurnScope,
  capability: CapabilityKey,
): Promise<void> => {
  await requireCapability({
    principal: await actingPrincipal(ctx),
    capability,
    teamId: ctx.teamId,
  });
};

/**
 * Contributing to the team's content — creating, changing, deleting it: its
 * leads and members do, a viewer reads (`team.content.create`).
 */
export const requireTurnContributor = (ctx: TurnScope): Promise<void> =>
  requireTurnCapability(ctx, "team.content.create");

/**
 * The project whose root something the assistant makes lands at: the one the
 * turn works in, unless a folder was named — a folder says where it lands,
 * in whatever project it is.
 */
export const turnRootProject = (
  ctx: Pick<AgentRuntimeContext, "projectId">,
  folderId: string | null | undefined,
): string | null => (folderId ? null : (ctx.projectId ?? null));

/**
 * Where something the assistant makes lands, and whether the person the turn
 * acts for may put it there (`requirePlacement`): the folder named; else the
 * root of the project the turn works in; else its team's root.
 */
export const requireTurnPlacement = async (
  ctx: TurnScope,
  where: { folderId?: string | null; contributes?: boolean },
): Promise<Placement> =>
  requirePlacement({
    principal: await actingPrincipal(ctx),
    activeTeamId: ctx.teamId,
    folderId: where.folderId ?? null,
    projectId: turnRootProject(ctx, where.folderId),
    ...(where.contributes === undefined
      ? {}
      : { contributes: where.contributes }),
  });

/** A Drive action, under the rules the API's Drive routes declare. */
export const requireTurnDriveAction = async (
  ctx: TurnScope,
  action: DriveAction,
): Promise<void> => {
  await requireDriveAction(await actingPrincipal(ctx), action);
};

/**
 * A level on the project the turn works in: `view` to read what it keeps for
 * the assistant, `edit` to change it, as for its instructions in the app.
 */
export const requireTurnProjectLevel = async (
  ctx: TurnScope & { projectId: string },
  required: AccessLevel,
): Promise<void> => {
  await requireAccess({
    principal: await actingPrincipal(ctx),
    type: "project",
    id: ctx.projectId,
    required,
    notFoundMessage: "Project not found",
  });
};
