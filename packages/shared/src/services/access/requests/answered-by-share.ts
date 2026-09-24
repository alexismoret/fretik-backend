import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import type { AccessRequest } from "../../../db/schema";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { notifyAccessDecided } from "./notify";

/**
 * Tell the people whose request a share just answered (`settle-requests.ts`)
 * — once the share has committed, as every email of a request.
 */
export const tellRequestersAnswered = async (input: {
  principal: UserPrincipal;
  settled: readonly AccessRequest[];
  resource: { type: SharingResourceType; id: string; name: string };
  level: AccessLevel;
}): Promise<void> => {
  if (input.settled.length === 0) return;
  const decider = await db.query.user.findFirst({
    columns: { name: true },
    where: { id: input.principal.userId },
  });
  await notifyAccessDecided({
    requests: input.settled,
    resource: input.resource,
    decision: "approved",
    level: input.level,
    deciderName: decider?.name ?? "",
  });
};
