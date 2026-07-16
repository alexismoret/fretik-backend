import { and, eq, sql, type SQL } from "drizzle-orm";
import db from "../../db";
import { workflows } from "../../db/schema";

/**
 * Remove a user from every workflow's `notifications.recipientUserIds`.
 *
 * The recipient list is jsonb (no FK), so nothing scrubs it automatically
 * when the user loses access. Called from the Better Auth lifecycle hooks
 * (`afterRemoveTeamMember` → team scope, `afterRemoveMember` → org scope,
 * `deleteUser.afterDelete` → global). Send time re-checks the roster via
 * `filterTeamMemberIds` anyway — this scrub is data hygiene, not the
 * security boundary — which is why hook callers may log-and-continue on
 * failure rather than block the removal.
 *
 * One set-based UPDATE: filters the jsonb array in place, touching only
 * rows that actually contain the user (`@>` containment).
 */
export const scrubWorkflowNotificationRecipient = async (params: {
  userId: string;
  /** Narrow the scrub to one team (member left the team). */
  teamId?: string;
  /** Narrow the scrub to one org (member removed from the organization). */
  organizationId?: string;
}): Promise<void> => {
  const conditions: SQL[] = [
    sql`${workflows.notifications}->'recipientUserIds' @> ${JSON.stringify([params.userId])}::jsonb`,
  ];
  if (params.teamId) conditions.push(eq(workflows.teamId, params.teamId));
  if (params.organizationId) {
    conditions.push(eq(workflows.organizationId, params.organizationId));
  }

  await db
    .update(workflows)
    .set({
      notifications: sql`jsonb_set(
        ${workflows.notifications},
        '{recipientUserIds}',
        (
          SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
          FROM jsonb_array_elements_text(${workflows.notifications}->'recipientUserIds') AS elem
          WHERE elem <> ${params.userId}
        )
      )`,
    })
    .where(and(...conditions));
};
