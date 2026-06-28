import { and, eq, isNull, or, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import { objectGrants, recordShares } from "../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../lib/errors";

/**
 * Write-side authorization for cross-team sharing — the symmetric counterpart of
 * the read predicates in `access.ts`. The object write SERVICES look subjects up
 * by id alone (so system callers — the document→graph fold, seeding — can write
 * across teams), so tenancy on the USER-FACING surfaces (API handlers, agent
 * tools, the code-mode SDK) is enforced HERE, at the boundary, before the call.
 *
 * The rule is "no writes to another team's subject without a write grant":
 *   - the OWNING team may always write its own subject;
 *   - an org/system TYPE (`team_id IS NULL`, same org) stays writable by any team
 *     in the org (unchanged behaviour — template-edit permissions are a separate
 *     concern, not a cross-team leak);
 *   - otherwise the caller needs a `write`-permission grant on the TYPE
 *     (team-scoped or org-wide) or, for a record, a `write`-permission SHARE on
 *     that record.
 * Anything cross-organization is `404` (never disclosed as existing).
 */

/** A `write` type grant to `teamId` (team-scoped or org-wide) exists. */
const hasTypeWriteGrant = async (input: {
  objectTypeId: string;
  teamId: string;
  organizationId: string;
  exec: Executor;
}): Promise<boolean> => {
  const [row] = await input.exec
    .select({ one: sql`1` })
    .from(objectGrants)
    .where(
      and(
        eq(objectGrants.objectTypeId, input.objectTypeId),
        eq(objectGrants.organizationId, input.organizationId),
        eq(objectGrants.permission, "write"),
        or(
          eq(objectGrants.granteeTeamId, input.teamId),
          isNull(objectGrants.granteeTeamId),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/** A `write` record share to `teamId` (team-scoped or org-wide) exists. */
const hasRecordWriteShare = async (input: {
  recordId: string;
  teamId: string;
  organizationId: string;
  exec: Executor;
}): Promise<boolean> => {
  const [row] = await input.exec
    .select({ one: sql`1` })
    .from(recordShares)
    .where(
      and(
        eq(recordShares.recordId, input.recordId),
        eq(recordShares.organizationId, input.organizationId),
        eq(recordShares.permission, "write"),
        or(
          eq(recordShares.granteeTeamId, input.teamId),
          isNull(recordShares.granteeTeamId),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/**
 * Assert `teamId` may write the object type `objectTypeId`. Owner team or a
 * `write` type grant; `404` cross-org / missing, `403` foreign without a grant.
 */
export const assertCanWriteType = async (input: {
  objectTypeId: string;
  teamId: string;
  organizationId: string;
  tx?: Executor;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const type = await exec.query.objectTypes.findFirst({
    columns: { teamId: true, organizationId: true },
    where: { id: input.objectTypeId },
  });
  if (!type || type.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  if (type.teamId === null || type.teamId === input.teamId) return;
  if (
    await hasTypeWriteGrant({
      objectTypeId: input.objectTypeId,
      teamId: input.teamId,
      organizationId: input.organizationId,
      exec,
    })
  ) {
    return;
  }
  return throwHttpError(403, forbidden("No write access to this object type"));
};

/**
 * Assert `teamId` may write the record `recordId`. Owner team, a `write` type
 * grant on its type, or a `write` share on the record; `404` cross-org / missing,
 * `403` foreign without a grant.
 */
export const assertCanWriteRecord = async (input: {
  recordId: string;
  teamId: string;
  organizationId: string;
  tx?: Executor;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const record = await exec.query.objectRecords.findFirst({
    columns: { teamId: true, organizationId: true, objectTypeId: true },
    where: { id: input.recordId },
  });
  if (!record || record.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Record not found"));
  }
  if (record.teamId === input.teamId) return;
  if (
    (await hasTypeWriteGrant({
      objectTypeId: record.objectTypeId,
      teamId: input.teamId,
      organizationId: input.organizationId,
      exec,
    })) ||
    (await hasRecordWriteShare({
      recordId: input.recordId,
      teamId: input.teamId,
      organizationId: input.organizationId,
      exec,
    }))
  ) {
    return;
  }
  return throwHttpError(403, forbidden("No write access to this record"));
};

/**
 * Assert `teamId` may write the field definition `fieldDefinitionId` — resolves
 * the field to its owning type and delegates to `assertCanWriteType`. `404` if
 * the field is missing or cross-org.
 */
export const assertCanWriteField = async (input: {
  fieldDefinitionId: string;
  teamId: string;
  organizationId: string;
  tx?: Executor;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const field = await exec.query.fieldDefinitions.findFirst({
    columns: { objectTypeId: true, organizationId: true },
    where: { id: input.fieldDefinitionId },
  });
  if (!field || field.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Field definition not found"));
  }
  return assertCanWriteType({
    objectTypeId: field.objectTypeId,
    teamId: input.teamId,
    organizationId: input.organizationId,
    tx: exec,
  });
};
