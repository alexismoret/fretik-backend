import { and, eq } from "drizzle-orm";
import db from "../../db";
import { invitation } from "../../db/schema";
import { type AccessEvent, recordAccessEvents } from "../access/record-event";

/**
 * Withdraw the pending invitations into a team that is being deleted.
 *
 * Better Auth clears a deleted team from its pending invitations, which turns
 * an invitation into that team alone into an invitation into the organization
 * with no team: whoever accepts it would join with nowhere to work, and
 * nobody invited them to that. So it is withdrawn instead, journaled like a
 * withdrawal from the invitations list. Called before the deletion: after
 * it, nothing on the row says which team it was for.
 */
export const withdrawInvitationsToDeletedTeam = async (input: {
  organizationId: string;
  teamId: string;
  teamName: string;
  actorUserId: string | null;
}): Promise<void> => {
  await db.transaction(async (tx) => {
    const withdrawn = await tx
      .update(invitation)
      .set({ status: "canceled" })
      .where(
        and(
          eq(invitation.organizationId, input.organizationId),
          eq(invitation.teamId, input.teamId),
          eq(invitation.status, "pending"),
        ),
      )
      .returning({ id: invitation.id, email: invitation.email });
    await recordAccessEvents(
      tx,
      withdrawn.map((row): AccessEvent => ({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "invitation.canceled",
        principal: { type: "invitation", id: row.id },
        metadata: {
          email: row.email,
          teamId: input.teamId,
          teamName: input.teamName,
          reason: "team.deleted",
        },
      })),
    );
  });
};
