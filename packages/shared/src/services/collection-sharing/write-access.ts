import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requireUserCapability } from "../../authz/gates";
import { loadPrincipal } from "../../authz/load-principal";
import {
  mirrorWriteRefusals,
  refuseMirrorWrite,
} from "../../authz/mirror-writes";
import type { UserPrincipal } from "../../authz/principal";
import { throwResourceRefusal } from "../../authz/refusals";
import { teamAgentPrincipal } from "../../authz/team-agent";
import db, { type Executor } from "../../db";
import {
  collectionGrants,
  collectionRecords,
  recordShares,
} from "../../db/schema";
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
 * And the PERSON behind the write must contribute to the acting team: its
 * leads and members do, a viewer reads (`team.content.create`). Every check
 * below takes `userId` for that — undefined only when no person is behind the
 * write (a team workflow acting as the team), which the team itself vouches
 * for.
 *
 * A record that MIRRORS a Drive file follows the file too: one kept to some
 * people takes `edit` on it, and reads as missing to whoever cannot open it
 * (`authz/mirror-writes.ts`).
 *
 * STRUCTURE is not data. A write grant opens a type's RECORDS, never its shape:
 * renaming, disabling or deleting the type, and adding or changing its fields,
 * stay with the team that owns it (`assertCanManageType`,
 * `assertCanEditTypeFields`, `assertCanWriteField`). An org-level type holds
 * every team's records, so changing the type itself is an org admin's call —
 * deleting one cascades the records of teams that never agreed to it.
 *
 * And the team's policy holds back what cannot be undone. With its members at
 * `edit` on the team's content (`memberContentLevel`), deleting and sharing
 * stay with its leads: changing a collection's sharing or deleting it, and
 * deleting a record, except one's own (`assertCanManageType`'s `change`,
 * `assertCanDeleteRecords`). Collections are not engine resources with levels
 * of their own yet, so their doors ask the person's level on the team's
 * content here.
 */

/** The person may contribute to the acting team's content: not a viewer. */
const requireContributor = async (input: {
  userId: string | undefined;
  teamId: string;
  organizationId: string;
}): Promise<void> => {
  if (input.userId === undefined) return;
  await requireUserCapability({
    userId: input.userId,
    organizationId: input.organizationId,
    capability: "team.content.create",
    teamId: input.teamId,
  });
};

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
  userId: string | undefined;
  tx?: Executor;
}): Promise<void> => {
  await requireContributor(input);
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
 * Who a record write is for, as the engine sees them: the person, or — with no
 * person behind it (a team workflow) — the team's agent, which reaches what
 * the team reaches and nothing private.
 */
const writerPrincipal = async (input: {
  teamId: string;
  organizationId: string;
  userId: string | undefined;
}): Promise<UserPrincipal | null> =>
  input.userId === undefined
    ? teamAgentPrincipal(input)
    : loadPrincipal({
        organizationId: input.organizationId,
        userId: input.userId,
      });

/**
 * Assert `teamId` may write the record `recordId`. Owner team, a `write` type
 * grant on its type, or a `write` share on the record; `404` cross-org / missing,
 * `403` foreign without a grant. A record that mirrors a file kept to some
 * people also takes `edit` on the file.
 */
export const assertCanWriteRecord = async (input: {
  recordId: string;
  teamId: string;
  organizationId: string;
  userId: string | undefined;
  tx?: Executor;
}): Promise<void> => {
  await requireContributor(input);
  const exec = input.tx ?? db;
  const record = await exec.query.collectionRecords.findFirst({
    columns: {
      teamId: true,
      organizationId: true,
      collectionId: true,
      inheritTypeSharing: true,
      documentId: true,
    },
    where: { id: input.recordId },
  });
  if (!record || record.organizationId !== input.organizationId) {
    return throwHttpError(404, notFound("Record not found"));
  }
  if (record.documentId !== null) {
    const principal = await writerPrincipal(input);
    if (principal === null) {
      return throwHttpError(404, notFound("Record not found"));
    }
    const refusal = (
      await mirrorWriteRefusals({
        principal,
        recordIds: [input.recordId],
        executor: exec,
      })
    ).get(input.recordId);
    if (refusal !== undefined) return refuseMirrorWrite(principal, refusal);
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
  /**
   * What changes: its details (the default), who may see it, or the type
   * itself going away. The last two take full access to the team's content.
   */
  change?: "details" | "sharing" | "delete";
  tx?: Executor;
}): Promise<void> => {
  await requireContributor(input);
  const type = await findTypeInOrganization({
    collectionId: input.collectionId,
    organizationId: input.organizationId,
    exec: input.tx ?? db,
  });
  if (type.teamId === input.teamId) {
    if ((input.change ?? "details") === "details") return;
    return requireFullTeamContent({
      userId: input.userId,
      teamId: input.teamId,
      organizationId: input.organizationId,
      collectionId: input.collectionId,
      message:
        input.change === "sharing"
          ? "Changing who can see this collection takes full access to the team's content."
          : "Deleting this collection takes full access to the team's content.",
    });
  }
  if (type.teamId === null) {
    if (input.userId === undefined) {
      return throwHttpError(
        403,
        forbidden("Only an organization admin can change this collection"),
      );
    }
    return requireUserCapability({
      userId: input.userId,
      organizationId: input.organizationId,
      capability: "organization.templates",
      message: "Only an organization admin can change this collection",
    });
  }
  return throwHttpError(
    403,
    forbidden("Only the team that owns this collection can change it"),
  );
};

/**
 * The records among `recordIds` of the team this person holds less than full
 * access to: the ones someone else created, while their level on the team's
 * content is short of full. Deleting a record and changing who may see it take
 * full access; the team's policy keeps both with its leads and each record's
 * author. Other teams' records are left out: the write grant or share they
 * came through decides those, as before.
 */
export const recordsShortOfFull = async (input: {
  principal: UserPrincipal;
  teamId: string;
  recordIds: readonly string[];
  tx?: Executor;
}): Promise<{ id: string; collectionId: string }[]> => {
  if (
    input.recordIds.length === 0 ||
    input.principal.teamContentLevels.get(input.teamId) === "full"
  ) {
    return [];
  }
  return (input.tx ?? db)
    .select({
      id: collectionRecords.id,
      collectionId: collectionRecords.collectionId,
    })
    .from(collectionRecords)
    .where(
      and(
        inArray(collectionRecords.id, [...input.recordIds]),
        eq(collectionRecords.teamId, input.teamId),
        sql`${collectionRecords.createdByUserId} IS DISTINCT FROM ${input.principal.userId}`,
      ),
    );
};

/** Why a record someone else created cannot be deleted, as every door says it. */
export const RECORD_DELETION_REFUSAL =
  "Deleting a record someone else created takes full access to the team's content.";

/** Why the sharing of a record someone else created cannot be changed. */
export const RECORD_SHARING_REFUSAL =
  "Changing who can see a record someone else created takes full access to the team's content.";

/**
 * Assert the person holds full access to these records of the team
 * (`recordsShortOfFull`), before deleting them or changing who may see them:
 * a 403 that says the level it takes and names whom to ask. A caller with no
 * person behind it is the team.
 */
const assertFullOnRecords = async (input: {
  recordIds: readonly string[];
  teamId: string;
  organizationId: string;
  userId: string | undefined;
  message: string;
  tx?: Executor;
}): Promise<void> => {
  if (input.userId === undefined || input.recordIds.length === 0) return;
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (principal === null) {
    return throwHttpError(404, notFound("Record not found"));
  }
  const [held] = await recordsShortOfFull({ ...input, principal });
  if (held === undefined) return;
  return refuseShortOfFull({
    principal,
    teamId: input.teamId,
    collectionId: held.collectionId,
    message: input.message,
  });
};

/** Deleting records of the team: full access, or having created them. */
export const assertCanDeleteRecords = (input: {
  recordIds: readonly string[];
  teamId: string;
  organizationId: string;
  userId: string | undefined;
  tx?: Executor;
}): Promise<void> =>
  assertFullOnRecords({ ...input, message: RECORD_DELETION_REFUSAL });

/** Changing who may see a record of the team: full access, or its author. */
export const assertCanShareRecord = (input: {
  recordId: string;
  teamId: string;
  organizationId: string;
  userId: string | undefined;
  tx?: Executor;
}): Promise<void> =>
  assertFullOnRecords({
    ...input,
    recordIds: [input.recordId],
    message: RECORD_SHARING_REFUSAL,
  });

/**
 * The person's level on the team's content is full: its leads, and its
 * members under the default policy. A caller with no person behind it is the
 * team, which vouches for itself.
 */
const requireFullTeamContent = async (input: {
  userId: string | undefined;
  teamId: string;
  organizationId: string;
  collectionId: string;
  message: string;
}): Promise<void> => {
  if (input.userId === undefined) return;
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (principal === null) {
    return throwHttpError(404, notFound("Collection not found"));
  }
  if (principal.teamContentLevels.get(input.teamId) === "full") return;
  return refuseShortOfFull({ principal, ...input });
};

/** A 403 that says the level it takes, and names the team's leads to ask. */
const refuseShortOfFull = (input: {
  principal: UserPrincipal;
  teamId: string;
  collectionId: string;
  message: string;
}): Promise<never> =>
  throwResourceRefusal({
    principal: input.principal,
    resource: {
      type: "collection",
      id: input.collectionId,
      ownerUserId: null,
      teamId: input.teamId,
    },
    required: "full",
    current: input.principal.teamContentLevels.get(input.teamId) ?? null,
    message: input.message,
  });

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
  userId: string | undefined;
  tx?: Executor;
}): Promise<void> => {
  await requireContributor(input);
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
    return requireUserCapability({
      userId: input.userId,
      organizationId: input.organizationId,
      capability: "organization.templates",
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
    userId: input.userId,
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
  userId: string | undefined;
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
    userId: input.userId,
    tx: exec,
  });
};
