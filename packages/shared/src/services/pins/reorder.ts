import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import { userPins } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import type { PinTarget } from "../../schemas/pins";

/** Stable identity of a pin within one (user, team) scope. */
const targetKey = (target: PinTarget): string =>
  `${target.targetType}:${target.targetId}`;

/**
 * Rewrite the caller's pin order from the FULL list they sent.
 *
 * The payload must cover exactly the caller's current set: ordering assigns a
 * dense 0…n-1, so a row left out would keep an index that now collides with an
 * assigned one, and the next read would order the two arbitrarily. A payload
 * that no longer matches the stored set means the sidebar was reordered against
 * a stale view (another tab pinned or unpinned meanwhile) — the caller reloads
 * and retries rather than silently dropping half the ordering.
 *
 * One set-based `UPDATE … FROM (VALUES …)`, never a loop of single-row updates.
 */
export const reorderUserPins = async (params: {
  userId: string;
  teamId: string;
  items: PinTarget[];
}): Promise<void> => {
  await db.transaction(async (tx): Promise<void> => {
    const current = await tx
      .select({
        targetType: userPins.targetType,
        targetId: userPins.targetId,
      })
      .from(userPins)
      .where(
        and(
          eq(userPins.userId, params.userId),
          eq(userPins.teamId, params.teamId),
        ),
      );

    const currentKeys = new Set(current.map(targetKey));
    const payloadKeys = new Set(params.items.map(targetKey));
    const coversExactly =
      payloadKeys.size === params.items.length &&
      payloadKeys.size === currentKeys.size &&
      current.every((row) => payloadKeys.has(targetKey(row)));
    if (!coversExactly) {
      return throwHttpError(400, {
        code: "PIN_REORDER_STALE",
        message:
          "The order must list exactly the pins you currently have, once each. Reload your pins and send the full list again.",
      });
    }
    if (params.items.length > 0) {
      const rows = params.items.map(
        (target, index) =>
          sql`(${target.targetType}::user_pin_target, ${target.targetId}::uuid, ${index}::integer)`,
      );
      await tx.execute(
        sql`UPDATE user_pins AS p
            SET display_order = v.display_order
            FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(target_type, target_id, display_order)
            WHERE p.user_id = ${params.userId}::uuid
              AND p.team_id = ${params.teamId}::uuid
              AND p.target_type = v.target_type
              AND p.target_id = v.target_id`,
      );
    }
  });
};
