import {
  type DriveVisibility,
  driveVisibility,
} from "@fretik/shared/authz/drive-sql";
import { loadPrincipal } from "@fretik/shared/authz/load-principal";
import type { UserPrincipal } from "@fretik/shared/authz/principal";
import {
  confineToProject,
  isTeamAgent,
} from "@fretik/shared/authz/project-agent";
import { forbidden, throwHttpError } from "@fretik/shared/lib/errors";
import { getTeamBotUserId } from "@fretik/shared/services/auth/bot-user";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * Who a tool acts for, as the access engine sees them.
 *
 * The assistant has no access of its own. It acts for whoever drives the
 * turn, with exactly their access: the member in a chat; in a workflow run,
 * the workflow's identity — its owner for a restricted workflow, the team's
 * agent otherwise (`create-run.ts` decides which, and puts it in `userId`).
 * A turn with no person behind it (an internal invocation) acts as the team's
 * agent too: it reaches what the team reaches, and nothing private. There is
 * no path to "no one, so everything".
 *
 * In a project, the team's agent works for the project alone
 * (`confineToProject`): a workflow of the project, or a project chat several
 * people read, reaches what everyone in the project reads and nothing else of
 * the team. A person keeps their own access wherever they write.
 *
 * Loaded through the principal cache, so a tool asking on every call costs
 * one Redis round trip. Someone removed from the organization mid-conversation
 * is refused, like at the API's door.
 */
export const actingPrincipal = async (
  ctx: Pick<
    AgentRuntimeContext,
    "organizationId" | "teamId" | "userId" | "projectId"
  >,
): Promise<UserPrincipal> => {
  const userId = ctx.userId ?? (await getTeamBotUserId(ctx.teamId));
  const principal = await loadPrincipal({
    organizationId: ctx.organizationId,
    userId,
  });
  if (!principal) {
    return throwHttpError(
      403,
      forbidden("You are no longer a member of this organization"),
    );
  }
  return ctx.projectId !== undefined && isTeamAgent(principal)
    ? confineToProject(principal, ctx.projectId)
    : principal;
};

/**
 * What the person the turn acts for can open in the team's Drive — the
 * filter every read of records takes, so a file kept from them never reaches
 * the assistant through its mirror record.
 */
export const actingDrive = async (
  ctx: Pick<
    AgentRuntimeContext,
    "organizationId" | "teamId" | "userId" | "projectId"
  >,
): Promise<DriveVisibility> =>
  driveVisibility(await actingPrincipal(ctx), ctx.teamId);
