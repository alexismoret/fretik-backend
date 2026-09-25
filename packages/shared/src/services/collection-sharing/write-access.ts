import { and, eq, isNull, or, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import { collectionGrants, recordShares } from "../../db/schema";
import { assertOrgAdmin } from "../../lib/auth-roles";
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
 *
 * STRUCTURE is not data. A write grant opens a type's RECORDS, never its shape:
 * renaming, disabling or deleting the type, and adding or changing its fields,
 * stay with the team that owns it (`assertCanManageType`,
 * `assertCanEditTypeFields`, `assertCanWriteField`). An org-level type holds
 * every team's records, so changing the type itself is an org admin's call —
 * deleting one cascades the records of teams that never agreed to it.
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

/** The type row the structural checks below all start from. */
const findTypeInOrganization = async (input: {
  collectionId: string;
  organizationId: string;
  exec: Executor;
}): Promise<{ teamId: string | null }> => {
  const type = await input.exec.query.collections.findFirst({
    columns: { teamId: true, organizationId: true },
    where: { id: input.collectionId },
  });
  if (!type || type.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Collection not found"));
  }
  return { teamId: type.teamId };
};

/**
 * Assert the caller may change the TYPE itself — rename, disable, re-index,
 * delete. The owning team may; an org-level type takes an org admin; another
 * team's type is refused whatever grant it carries.
 */
export const assertCanManageType = async (input: {
  collectionId: string;
  teamId: string;
  organizationId: string;
  /** Undefined for a caller with no person behind it (a team workflow). */
  userId: string | undefined;
  tx?: Executor;
}): Promise<void> => {
  const type = await findTypeInOrganization({
    collectionId: input.collectionId,
    organizationId: input.organizationId,
    exec: input.tx ?? db,
  });
  if (type.teamId === input.teamId) return;
  if (type.teamId === null) {
    if (input.userId === undefined) {
      return throwHttpError(
        403,
        forbidden("Only an organization admin can change this collection"),
      );
    }
    return assertOrgAdmin({
      userId: input.userId,
      organizationId: input.organizationId,
      message: "Only an organization admin can change this collection",
    });
  }
  return throwHttpError(
    403,
    forbidden("Only the team that owns this collection can change it"),
  );
};

/**
 * Assert `teamId` may add or edit ITS OWN field definitions on the type: its
 * own type, or an org-level type (whose field rows are per team). Another
 * team's type is refused even with a write grant — the field row would belong
 * to the grantee, and the owner's reads would never show it.
 */
export const assertCanEditTypeFields = async (input: {
  collectionId: string;
  teamId: string;
  organizationId: string;
  tx?: Executor;
}): Promise<void> => {
  const type = await findTypeInOrganization({
    collectionId: input.collectionId,
    organizationId: input.organizationId,
    exec: input.tx ?? db,
  });
  if (type.teamId === null || type.teamId === input.teamId) return;
  return throwHttpError(
    403,
    forbidden("Only the team that owns this collection can change its fields"),
  );
};

/**
 * Assert the caller may change or delete the field definition
 * `fieldDefinitionId`. A team's own row, on a type it may edit fields of; an
 * org template (`team_id IS NULL`) for an org admin only — the same gate that
 * creating one has. Another team's definition is refused: on an org-level type
 * every team has its own rows, and deleting one with `cascade` drops that
 * team's data. `404` if the field is missing or cross-org.
 */
export const assertCanWriteField = async (input: {
  fieldDefinitionId: string;
  teamId: string;
  organizationId: string;
  userId: string;
  tx?: Executor;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const field = await exec.query.fieldDefinitions.findFirst({
    columns: { collectionId: true, organizationId: true, teamId: true },
    where: { id: input.fieldDefinitionId },
  });
  if (!field || field.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Field definition not found"));
  }
  if (field.teamId === null) {
    return assertOrgAdmin({
      userId: input.userId,
      organizationId: input.organizationId,
      message: "Only an organization admin can change an organization field",
    });
  }
  if (field.teamId !== input.teamId) {
    return throwHttpError(403, forbidden("This field belongs to another team"));
  }
  return assertCanEditTypeFields({
    collectionId: field.collectionId,
    teamId: input.teamId,
    organizationId: input.organizationId,
    tx: exec,
  });
};

/**
 * Assert `teamId` may invalidate the edge `linkId`: the same right it needs to
 * create one — write access to the record the edge starts from. `404` if the
 * edge is missing or cross-org.
 */
export const assertCanWriteLink = async (input: {
  linkId: string;
  teamId: string;
  organizationId: string;
  tx?: Executor;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const link = await exec.query.links.findFirst({
    columns: { fromRecordId: true, organizationId: true },
    where: { id: input.linkId },
  });
  if (!link || link.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Link not found"));
  }
  return assertCanWriteRecord({
    recordId: link.fromRecordId,
    teamId: input.teamId,
    organizationId: input.organizationId,
    tx: exec,
  });
};
