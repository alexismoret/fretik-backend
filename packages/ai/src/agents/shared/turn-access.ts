import {
  type DriveAction,
  requireDriveAction,
} from "@fretik/shared/authz/drive";
import { requireCapability } from "@fretik/shared/authz/gates";
import type { CapabilityKey } from "@fretik/shared/schemas/access";
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
  "organizationId" | "teamId" | "userId"
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

/** A Drive action, under the rules the API's Drive routes declare. */
export const requireTurnDriveAction = async (
  ctx: TurnScope,
  action: DriveAction,
): Promise<void> => {
  await requireDriveAction(await actingPrincipal(ctx), action);
};
