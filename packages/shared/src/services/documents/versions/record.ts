import { and, desc, eq, notInArray } from "drizzle-orm";

import db from "../../../db";
import {
  documentVersions,
  type Document,
  type DocumentVersion,
  type DocumentVersionActor,
} from "../../../db/schema/documents";
import { buildDocumentOriginalKey } from "../../../lib/document-storage";
import { deleteFilesFromS3 } from "../../../lib/s3";

/**
 * Version bookkeeping for documents. The bytes are moved by
 * `replace-content.ts`; this file owns the ROWS — allocating version numbers,
 * coalescing a typing session into one version, and bounding the history.
 */

/**
 * Versions kept per document. The 21st write evicts the oldest — bounded
 * without a TTL job, same discipline as `HISTORY_RETENTION_PER_MEMORY`.
 *
 * A count, not a byte budget: 20 markdown revisions are noise, 20 revisions of
 * a 10 MB PDF are 200 MB. If that ever bites, a byte cap goes in the eviction
 * below without touching the schema.
 */
export const DOCUMENT_VERSION_RETENTION = 20;

/**
 * Consecutive edits by the same author inside this window update the current
 * version instead of appending one. An editing session is one version, not one
 * per autosave — without it a 20-slot history holds four minutes of typing.
 */
export const VERSION_COALESCE_WINDOW_MS = 10 * 60 * 1000;

/** Who is writing, for attribution on the version row. */
export interface DocumentVersionActorContext {
  actor: DocumentVersionActor;
  /** The person behind the write — set for UI edits AND for agent writes
   * (the agent acts on someone's behalf), null only for system paths. */
  userId: string | null;
  /** The conversation an agent write came from. Null for UI edits. */
  conversationId?: string | null;
}

/**
 * Newest version row of a document, MATERIALISING v1 when the document
 * predates versioning (or was created outside the authored path).
 *
 * Back-filling on demand rather than by migration: v1's bytes are the live
 * original, already on S3, so the row is pure metadata the document row
 * already carries. Nothing to copy, nothing to backfill offline, and a
 * document nobody edits never pays for the row at all.
 */
export const getCurrentVersion = async (
  document: Pick<
    Document,
    | "id"
    | "teamId"
    | "mimeType"
    | "fileSize"
    | "fileHash"
    | "originalFilename"
    | "uploadedById"
  >,
): Promise<DocumentVersion> => {
  const existing = await db.query.documentVersions.findFirst({
    where: { documentId: document.id },
    orderBy: { versionNumber: "desc" },
  });
  if (existing) return existing;

  const [created] = await db
    .insert(documentVersions)
    .values({
      documentId: document.id,
      teamId: document.teamId,
      versionNumber: 1,
      operation: "create",
      storageKey: buildDocumentOriginalKey(
        document.id,
        document.originalFilename,
      ),
      mimeType: document.mimeType,
      fileSize: document.fileSize,
      fileHash: document.fileHash,
      // The document row already records who put the file here — use it rather
      // than leaving every back-filled v1 authorless in the history panel.
      byUserId: document.uploadedById,
      byActor: "human",
      byConversationId: null,
    })
    // A concurrent save may have materialised v1 first; take theirs.
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const raced = await db.query.documentVersions.findFirst({
    where: { documentId: document.id },
    orderBy: { versionNumber: "desc" },
  });
  if (!raced) {
    throw new Error(
      `Failed to materialise version 1 for document ${document.id}`,
    );
  }
  return raced;
};

/**
 * Should this write fold into the current version instead of appending one?
 *
 * Only ever true for `edit` (an in-app authored save). A `replace` is someone
 * deliberately dropping different bytes in and a `restore` is a deliberate
 * rollback — both are events a user expects to find in the history, however
 * fast they follow one another.
 */
export const shouldCoalesce = (args: {
  current: DocumentVersion;
  operation: string;
  actorContext: DocumentVersionActorContext;
  now: number;
}): boolean =>
  args.operation === "edit" &&
  args.current.operation === "edit" &&
  args.current.byActor === args.actorContext.actor &&
  args.current.byUserId === args.actorContext.userId &&
  args.now - args.current.createdAt.getTime() < VERSION_COALESCE_WINDOW_MS;

/**
 * Drop versions beyond the retention window, archives included.
 *
 * Best-effort hygiene run OUTSIDE the write's transaction — a slow trim must
 * never hold up a user-visible save. Returns the freed bytes so the caller
 * refunds the team's storage counter.
 *
 * The newest version is never a candidate: its `storageKey` IS the live
 * original, and deleting that would destroy the document.
 */
export const trimDocumentVersions = async (
  documentId: string,
): Promise<number> => {
  const keepers = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNumber))
    .limit(DOCUMENT_VERSION_RETENTION);

  if (keepers.length < DOCUMENT_VERSION_RETENTION) return 0;

  const evicted = await db
    .delete(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        notInArray(
          documentVersions.id,
          keepers.map((r) => r.id),
        ),
      ),
    )
    .returning({
      storageKey: documentVersions.storageKey,
      fileSize: documentVersions.fileSize,
    });

  if (evicted.length === 0) return 0;

  await deleteFilesFromS3(evicted.map((row) => row.storageKey));
  return evicted.reduce((total, row) => total + row.fileSize, 0);
};
