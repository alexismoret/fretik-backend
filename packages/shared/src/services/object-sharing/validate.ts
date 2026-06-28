import db from "../../db";
import {
  badRequest,
  forbidden,
  notFound,
  throwHttpError,
} from "../../lib/errors";

/**
 * Shared validation for the sharing layer. Every grant/share is anchored to an
 * OWNER team: only a team that owns the type/record may share it, and only with
 * another team in the SAME organization. A NULL grantee means "org-wide". These
 * guards keep the ACL rows well-formed before they ever reach the RLS helpers
 * (`fretik_type_granted` / `fretik_record_shared`), which trust the rows.
 */

/**
 * Assert the object type exists, belongs to `organizationId`, and is owned by
 * `ownerTeamId`. Only team-owned types are shareable — org/system types
 * (`teamId IS NULL`) are already visible org-wide, so sharing them is a no-op
 * and rejected. Returns the type row.
 */
export const assertSharableType = async (input: {
  objectTypeId: string;
  ownerTeamId: string;
  organizationId: string;
}) => {
  const type = await db.query.objectTypes.findFirst({
    where: { id: input.objectTypeId },
  });
  if (!type || type.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  if (type.teamId !== input.ownerTeamId) {
    return throwHttpError(
      403,
      forbidden("Only the owning team can share this type"),
    );
  }
  return type;
};

/**
 * Assert the record exists, belongs to `organizationId`, and is owned by
 * `ownerTeamId`. Returns the record row.
 */
export const assertSharableRecord = async (input: {
  recordId: string;
  ownerTeamId: string;
  organizationId: string;
}) => {
  const record = await db.query.objectRecords.findFirst({
    where: { id: input.recordId },
  });
  if (!record || record.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Record not found"));
  }
  if (record.teamId !== input.ownerTeamId) {
    return throwHttpError(
      403,
      forbidden("Only the owning team can share this record"),
    );
  }
  return record;
};

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
