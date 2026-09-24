import { and, eq, ne, sql } from "drizzle-orm";
import type { LoadedNode } from "../../../authz/resources/types";
import type { Executor } from "../../../db";
import { accessGrants } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { ERROR_CODES } from "../../../schemas/errors";
import { accessGrantStore } from "./grant-stores/access-grants";
import { collectionGrantStore } from "./grant-stores/collection-grants";
import { conversationGrantStore } from "./grant-stores/conversation-seats";
import type { PrincipalRef } from "./principals";

/**
 * Who a resource was shared with, as the sharing services read and change it,
 * whatever table the resource keeps that in. Read and written inside the
 * caller's transaction, row-locked, so two people changing the same share at
 * once cannot both believe they left someone with full access.
 *
 * Most types keep their grants in `access_grants`. Two keep rows that
 * something else already reads, and the sharing services write those instead,
 * so there is one list whichever door changes it:
 *   - a chat's participants are its seats (`grant-stores/conversation-seats`);
 *   - a collection's grants are the ones the SQL tool enforces
 *     (`grant-stores/collection-grants`).
 */

export interface StoredGrant extends PrincipalRef {
  readonly level: AccessLevel;
}

/** A grant as the share dialog lists it. */
export interface StoredHolder extends StoredGrant {
  readonly grantedAt: Date;
  readonly grantedBy: { readonly userId: string; readonly name: string } | null;
}

interface StoredResource {
  readonly type: SharingResourceType;
  readonly id: string;
}

/** Where one type keeps who it was shared with. */
export interface GrantStore {
  /** The grants of these principals, locked for the change. */
  lock(
    tx: Executor,
    resource: StoredResource,
    refs: readonly PrincipalRef[],
  ): Promise<StoredGrant[]>;
  /** Every grant of the resource. */
  list(executor: Executor, resource: StoredResource): Promise<StoredHolder[]>;
  /** Give these principals `level`, created or changed. */
  upsert(
    tx: Executor,
    write: {
      readonly organizationId: string;
      readonly resource: StoredResource;
      readonly refs: readonly PrincipalRef[];
      readonly level: AccessLevel;
      readonly actorUserId: string;
    },
  ): Promise<void>;
  /** Take these principals' access away. */
  remove(
    tx: Executor,
    resource: StoredResource,
    refs: readonly PrincipalRef[],
  ): Promise<void>;
}

const storeFor = (type: SharingResourceType): GrantStore => {
  switch (type) {
    case "conversation":
      return conversationGrantStore;
    case "collection":
      return collectionGrantStore;
    case "folder":
    case "document":
    case "page":
    case "workflow":
      return accessGrantStore;
  }
};

/** The grants of the resource to these principals, locked for the change. */
export const lockGrants = (
  tx: Executor,
  resource: StoredResource,
  refs: readonly PrincipalRef[],
): Promise<StoredGrant[]> =>
  refs.length === 0
    ? Promise.resolve([])
    : storeFor(resource.type).lock(tx, resource, refs);

/** Every grant of the resource, for the share dialog. */
export const listGrants = (
  executor: Executor,
  resource: StoredResource,
): Promise<StoredHolder[]> => storeFor(resource.type).list(executor, resource);

/** Write these grants at `level`, created or changed. */
export const upsertGrants = async (
  tx: Executor,
  input: Parameters<GrantStore["upsert"]>[1],
): Promise<void> => {
  if (input.refs.length === 0) return;
  await storeFor(input.resource.type).upsert(tx, input);
};

/** Remove these grants. */
export const deleteGrants = async (
  tx: Executor,
  resource: StoredResource,
  refs: readonly PrincipalRef[],
): Promise<void> => {
  if (refs.length === 0) return;
  await storeFor(resource.type).remove(tx, resource, refs);
};

/**
 * Refuse a change that would leave a restricted resource with no owner and
 * nobody with full access. `losing` are the grants the change removes or
 * lowers below full; they are not counted. Only the engine's own grants give
 * full access: a seat takes part, a collection's grant reads or edits.
 */
export const assertSomeoneKeepsFullAccess = async (
  tx: Executor,
  node: LoadedNode,
  losing: readonly PrincipalRef[],
): Promise<void> => {
  if (!node.restricted || node.ownerUserId !== null || losing.length === 0) {
    return;
  }
  const [row] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, node.type),
        eq(accessGrants.resourceId, node.id),
        eq(accessGrants.level, "full"),
        ne(accessGrants.principalType, "invitation"),
        ...losing.map(
          (ref) =>
            sql`NOT (${accessGrants.principalType} = ${ref.type} AND ${accessGrants.principalId} = ${ref.id})`,
        ),
      ),
    );
  if ((row?.count ?? 0) === 0) {
    throwHttpError(409, {
      code: ERROR_CODES.LAST_FULL_ACCESS,
      message:
        "Someone must keep full access to this item: its owner is gone and it is restricted.",
    });
  }
};
