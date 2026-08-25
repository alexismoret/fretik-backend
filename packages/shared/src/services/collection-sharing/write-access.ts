import { and, eq, isNull, or, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import { collectionGrants, recordShares } from "../../db/schema";
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
  collectionId: string;
  teamId: string;
  organizationId: string;
  exec: Executor;
}): Promise<boolean> => {
  const [row] = await input.exec
    .select({ one: sql`1` })
    .from(collectionGrants)
    .where(
      and(
        eq(collectionGrants.collectionId, input.collectionId),
        eq(collectionGrants.organizationId, input.organizationId),
        eq(collectionGrants.permission, "write"),
        or(
          eq(collectionGrants.granteeTeamId, input.teamId),
          isNull(collectionGrants.granteeTeamId),
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
 * Assert `teamId` may write the collection `collectionId`. Owner team or a
 * `write` type grant; `404` cross-org / missing, `403` foreign without a grant.
 */
export const assertCanWriteType = async (input: {
  collectionId: string;
  teamId: string;
  organizationId: string;
  tx?: Executor;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const type = await exec.query.collections.findFirst({
    columns: { teamId: true, organizationId: true },
    where: { id: input.collectionId },
  });
  if (!type || type.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Collection not found"));
  }
  if (type.teamId === null || type.teamId === input.teamId) return;
  if (
    await hasTypeWriteGrant({
      collectionId: input.collectionId,
      teamId: input.teamId,
      organizationId: input.organizationId,
      exec,
    })
  ) {
    return;
  }
  return throwHttpError(403, forbidden("No write access to this collection"));
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
  const record = await exec.query.collectionRecords.findFirst({
    columns: {
      teamId: true,
      organizationId: true,
      collectionId: true,
      inheritTypeSharing: true,
    },
    where: { id: input.recordId },
  });
  if (!record || record.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Record not found"));
  }
  if (record.teamId === input.teamId) return;
  // A type `write` grant only opens a record that still INHERITS the type's
  // sharing; a custom record (inherit=false) is reachable only through its own
  // `write` share — mirrors `fretik_record_visible`.
  if (
    (record.inheritTypeSharing &&
      (await hasTypeWriteGrant({
        collectionId: record.collectionId,
        teamId: input.teamId,
        organizationId: input.organizationId,
        exec,
      }))) ||
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
    columns: { collectionId: true, organizationId: true },
    where: { id: input.fieldDefinitionId },
  });
  if (!field || field.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Field definition not found"));
  }
  return assertCanWriteType({
    collectionId: field.collectionId,
    teamId: input.teamId,
    organizationId: input.organizationId,
    tx: exec,
  });
};
