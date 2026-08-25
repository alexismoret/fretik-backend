import { and, eq } from "drizzle-orm";
import db from "../../db";
import { userPins } from "../../db/schema";
import type { PinTarget } from "../../schemas/pins";

/**
 * Unpin one target. An exact-match DELETE on the primary key, and deliberately
 * NOT a 404 when nothing matched: like `setUserFileMute(false)`, this is a
 * personal toggle the UI fires optimistically, and "it is already gone" is the
 * outcome the caller asked for.
 *
 * No scope beyond (user, team) is needed — the two columns are part of the key,
 * so a caller can only ever delete their own row in their own team.
 */
export const unpinTarget = async (params: {
  userId: string;
  teamId: string;
  target: PinTarget;
}): Promise<void> => {
  await db
    .delete(userPins)
    .where(
      and(
        eq(userPins.userId, params.userId),
        eq(userPins.teamId, params.teamId),
        eq(userPins.targetType, params.target.targetType),
        eq(userPins.targetId, params.target.targetId),
      ),
    );
};
