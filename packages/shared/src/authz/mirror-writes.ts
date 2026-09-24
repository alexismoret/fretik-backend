import { and, inArray, isNotNull } from "drizzle-orm";
import db, { type Executor } from "../db";
import { collectionRecords } from "../db/schema";
import { chunkForBulk } from "../lib/db-bulk";
import { notFound, throwHttpError } from "../lib/errors";
import type { AccessLevel } from "../schemas/access";
import { adapterFor } from "./access";
import { isOpenToItsTeam } from "./drive-sql";
import { atLeast } from "./levels";
import type { Principal, UserPrincipal } from "./principal";
import { throwResourceRefusal } from "./refusals";
import type { LoadedNode } from "./resources/types";
import { computeLevel } from "./rules";

/**
 * Writing the record that MIRRORS a file (`collection_records.document_id`)
 * writes that file's name and fields.
 *
 * For a file open to its whole team, the record's own write rules decide
 * (`collection-sharing/write-access.ts`), as for any record: the team's
 * contributors edit it, a write grant opens it to another team. For a file
 * kept to some people, the writer must be able to EDIT the file — and a file
 * they cannot open at all is answered like a record that does not exist,
 * exactly as every read answers it (`drive-sql.ts`, `mirrorRecordVisible`).
 */
export type MirrorWriteRefusal =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "read_only";
      readonly file: LoadedNode;
      readonly level: AccessLevel;
    };

/** The records of `recordIds` whose file keeps this writer out, and why. */
export const mirrorWriteRefusals = async (input: {
  principal: Principal;
  recordIds: readonly string[];
  executor?: Executor;
}): Promise<Map<string, MirrorWriteRefusal>> => {
  const refusals = new Map<string, MirrorWriteRefusal>();
  const { principal } = input;
  if (principal.kind === "system" || input.recordIds.length === 0) {
    return refusals;
  }
  const exec = input.executor ?? db;

  const mirrors: { id: string; documentId: string }[] = [];
  for (const chunk of chunkForBulk([...new Set(input.recordIds)])) {
    // oxlint-disable-next-line no-await-in-loop -- one read per chunk
    const rows = await exec
      .select({
        id: collectionRecords.id,
        documentId: collectionRecords.documentId,
      })
      .from(collectionRecords)
      .where(
        and(
          inArray(collectionRecords.id, chunk),
          isNotNull(collectionRecords.documentId),
        ),
      );
    for (const row of rows) {
      if (row.documentId !== null) {
        mirrors.push({ id: row.id, documentId: row.documentId });
      }
    }
  }
  if (mirrors.length === 0) return refusals;

  const files = await adapterFor("document").loadNodes(
    [...new Set(mirrors.map((mirror) => mirror.documentId))],
    exec,
  );
  for (const mirror of mirrors) {
    const file = files.get(mirror.documentId);
    if (file === undefined || isOpenToItsTeam(file)) continue;
    const level = computeLevel(principal, file);
    if (level === null) {
      refusals.set(mirror.id, { kind: "hidden" });
    } else if (!atLeast(level, "edit")) {
      refusals.set(mirror.id, { kind: "read_only", file, level });
    }
  }
  return refusals;
};

/**
 * Refuse one write the way a single-record route answers: 404 for a file the
 * writer cannot open, 403 naming the file (and whom to ask) for one they may
 * only read.
 */
export const refuseMirrorWrite = async (
  principal: UserPrincipal,
  refusal: MirrorWriteRefusal,
): Promise<never> => {
  if (refusal.kind === "hidden") {
    return throwHttpError(404, notFound("Record not found"));
  }
  return throwResourceRefusal({
    principal,
    resource: {
      type: "document",
      id: refusal.file.id,
      ownerUserId: refusal.file.ownerUserId,
      teamId: refusal.file.teamId,
    },
    required: "edit",
    current: refusal.level,
  });
};

/** The per-row error a batch reports for a refused record. */
export const mirrorWriteError = (refusal: MirrorWriteRefusal): string =>
  refusal.kind === "hidden"
    ? "Record not found."
    : "This record mirrors a file you can view but not edit.";

/**
 * Split a batch of record ids into the ones this writer may write and the
 * refused ones, each with its error — for the batch surfaces, which report per
 * row rather than refuse the whole batch.
 */
export const partitionMirrorWrites = async (input: {
  principal: Principal;
  recordIds: readonly string[];
  executor?: Executor;
}): Promise<{
  writable: string[];
  refused: { id: string; error: string }[];
}> => {
  const refusals = await mirrorWriteRefusals(input);
  const writable: string[] = [];
  const refused: { id: string; error: string }[] = [];
  for (const id of input.recordIds) {
    const refusal = refusals.get(id);
    if (refusal === undefined) writable.push(id);
    else refused.push({ id, error: mirrorWriteError(refusal) });
  }
  return { writable, refused };
};
