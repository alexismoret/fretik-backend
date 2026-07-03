import db from "../../db";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";

/**
 * Shared validation for the sharing layer. A grant/share is anchored to an OWNER
 * team (owner-eligibility is asserted at the API/tool boundary) and may only
 * target another team in the SAME organization; a NULL grantee means "org-wide".
 * This guard keeps the ACL rows well-formed before they reach the RLS helpers
 * (`fretik_record_visible`), which trust the rows.
 */

/**
 * Assert the grantee team is a real team in the organization and is NOT the
 * owner team (sharing with yourself is meaningless). `null` grantee (org-wide)
 * skips the check.
 */
export const assertValidGrantee = async (input: {
  granteeTeamId: string | null;
  ownerTeamId: string;
  organizationId: string;
}): Promise<void> => {
  if (input.granteeTeamId === null) return;
  if (input.granteeTeamId === input.ownerTeamId) {
    throwHttpError(400, badRequest("Cannot share with the owning team"));
  }
  const grantee = await db.query.team.findFirst({
    where: {
      id: input.granteeTeamId,
      organizationId: input.organizationId,
    },
  });
  if (!grantee) {
    throwHttpError(
      404,
      notFound("Grantee team not found in this organization"),
    );
  }
};
