import { and, eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { UserPinTarget } from "../../db/schema";
import { userPins } from "../../db/schema";

/**
 * Reap every user's pin on a target that is being deleted, across all teams.
 *
 * `user_pins.targetId` carries no foreign key — one generic column cannot
 * reference two parents — so the cascade has to be written by hand, inside the
 * deleting transaction: a rollback must leave the pins pointing at the target
 * that survived. `services/pins/list.ts` sweeps whatever a path that does not
 * call this leaves behind.
 */
export const deletePinsForTarget = async (params: {
  targetType: UserPinTarget;
  targetId: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = params.tx ?? db;
  await exec
    .delete(userPins)
    .where(
      and(
        eq(userPins.targetType, params.targetType),
        eq(userPins.targetId, params.targetId),
      ),
    );
};
