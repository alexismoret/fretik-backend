import { and, eq, inArray } from "drizzle-orm";
import {
  type DriveVisibility,
  mirrorRecordVisible,
} from "../../authz/drive-sql";
import db, { type Executor } from "../../db";
import { collectionRecords, collections } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { collectionReadableCondition, recordReadableCondition } from "./access";

/**
 * Read-side authorization for single subjects — the counterpart of
 * `write-access.ts` for the paths that fetch a record BY ID.
 *
 * The list paths already filter through `recordVisibilityCondition`; a by-id
 * read has no list to filter, and the record services look rows up by id alone
 * (system callers — the graph fold, the journal — legitimately read across
 * teams). So a user-facing read asserts here first, and anything it returns
 * that names OTHER records (the far end of a link) is narrowed with
 * `listReadableRecordIds` before it leaves.
 *
 * A record the team may not read answers 404, exactly like one that does not
 * exist: its existence is itself the thing being protected. So does the
 * mirror of a document the PERSON cannot open (`drive`): the team may read
 * its records, the person may still not see that file.
 */

/** The subset of `recordIds` the viewer may read, in one query. */
export const listReadableRecordIds = async (input: {
  recordIds: string[];
  teamId: string;
  organizationId: string;
  /** What the person can open in the Drive: a hidden file's mirror is out. */
  drive: DriveVisibility;
  executor?: Executor;
}): Promise<Set<string>> => {
  const recordIds = [...new Set(input.recordIds)];
  if (recordIds.length === 0) return new Set();

  const executor = input.executor ?? db;
  const rows = await executor
    .select({ id: collectionRecords.id })
    .from(collectionRecords)
    .where(
      and(
        inArray(collectionRecords.id, recordIds),
        recordReadableCondition(input.teamId, input.organizationId),
        mirrorRecordVisible(input.drive, collectionRecords.documentId),
      ),
    );
  return new Set(rows.map((row) => row.id));
};

/** Refuse (404) a record the viewer may not read. */
export const assertCanReadRecord = async (input: {
  recordId: string;
  teamId: string;
  organizationId: string;
  drive: DriveVisibility;
  executor?: Executor;
}): Promise<void> => {
  const readable = await listReadableRecordIds({
    recordIds: [input.recordId],
    teamId: input.teamId,
    organizationId: input.organizationId,
    drive: input.drive,
    executor: input.executor,
  });
  if (!readable.has(input.recordId)) {
    return throwHttpError(404, notFound("Record not found"));
  }
};

/**
 * Whether `teamId` may read the collection `collectionId`, the organization
 * taken from the team itself. For callers that only carry a team — the page
 * data sources run "under a team's scope" — so a collection id written into a
 * page definition can never name another organization's type.
 */
export const canTeamReadCollection = async (input: {
  collectionId: string;
  teamId: string;
}): Promise<boolean> => {
  const viewer = await db.query.team.findFirst({
    columns: { organizationId: true },
    where: { id: input.teamId },
  });
  if (!viewer) return false;

  const [row] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.id, input.collectionId),
        collectionReadableCondition(input.teamId, viewer.organizationId),
      ),
    )
    .limit(1);
  return row !== undefined;
};
