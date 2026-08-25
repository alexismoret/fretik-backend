import { eq, sql } from "drizzle-orm";

import db from "../../../db";
import { teamSettings } from "../../../db/schema";
import {
  documentVersions,
  documents,
  type Document,
  type DocumentVersion,
} from "../../../db/schema/documents";
import { isMarkdownMime } from "../../../file-types";
import {
  buildDocumentOriginalKey,
  buildDocumentVersionKey,
} from "../../../lib/document-storage";
import { createApiError, notFound, throwHttpError } from "../../../lib/errors";
import { copyObject, uploadToS3 } from "../../../lib/s3";
import { ERROR_CODES } from "../../../schemas/errors";
import { resolveDocumentRecordId } from "../../collection-records/resolve-document-record";
import { emitDomainEvent, type EventActor } from "../../domain-events/emit";
import { enqueueDocumentProcessing } from "../processing-queue";
import { scheduleDocumentVectorRefresh } from "../vector-refresh-queue";
import {
  getCurrentVersion,
  shouldCoalesce,
  trimDocumentVersions,
  type DocumentVersionActorContext,
} from "./record";

/**
 * Put new bytes into an existing document — THE write path behind every
 * version, whatever the file type.
 *
 * One primitive serves the three user-visible gestures because they differ
 * only in intent: saving an authored markdown (`edit`), dropping a newer file
 * over an existing one (`replace` — a re-upload, or the agent promoting a
 * regenerated deliverable), and rolling back (`restore`, which is `replace`
 * with bytes read out of an older version). The document keeps its id, its
 * mirror record, its links and its place in the Drive; only its content moves.
 *
 * Ordering is chosen so a crash can never lose bytes: the outgoing content is
 * archived and its row repointed BEFORE the new content overwrites the live
 * key. A crash mid-way leaves the old bytes readable in the archive and heals
 * on the next save.
 */

/** Which artefacts a replacement invalidates, decided from the file type. */
const needsReprocessing = (mimeType: string): boolean =>
  !isMarkdownMime(mimeType);

/**
 * Turn "someone else minted this version number first" into the 409 the rest
 * of this path already speaks.
 *
 * Two writers that both pass the staleness checks and then interleave collide
 * on `document_versions_document_number_unique`, and the raw Postgres error is
 * what reached the caller. It is NOT retried, deliberately: by the time the
 * insert fails, this call has already overwritten the live key with its own
 * bytes, so re-numbering and inserting again would record a version whose
 * storage key holds someone else's content and quietly drop the version that
 * won the race. Losing a write loudly is recoverable — the caller re-reads and
 * saves again, which is exactly what `DOCUMENT_STALE` asks for; losing one
 * silently is not.
 */
const withVersionNumberConflictAsStale = async <T>(
  documentId: string,
  work: Promise<T>,
): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "23505") throw error;
    console.warn(
      `[documents] concurrent version write on ${documentId} — rejected as stale`,
    );
    return throwHttpError(
      409,
      createApiError(
        ERROR_CODES.DOCUMENT_STALE,
        "Someone else saved this document while your change was being written. Reload to see their version, then save again.",
      ),
    );
  }
};

/**
 * The journal actor behind a version, from the version's own actor context.
 *
 * `documentVersions.byActor` is a two-value audit enum (`agent` | `human`)
 * while the journal's is four-valued; a human save is a `user` event and an
 * agent save is an `agent` event carrying its conversation. Neither is
 * `system`: every replacement has someone behind it, even a workflow run,
 * which is why the conversation travels along.
 */
const journalActorFor = (context: DocumentVersionActorContext): EventActor => ({
  actorType: context.actor === "human" ? "user" : "agent",
  actorUserId: context.userId ?? null,
  conversationId: context.conversationId ?? null,
  ...(context.actor === "agent" ? { agentKey: "chatbot" } : {}),
});

export interface ReplaceContentResult {
  document: Document;
  version: DocumentVersion;
  /**
   * True when the bytes matched what was already stored, so nothing was
   * written and no version was created. Re-uploading the identical file is the
   * commonest accidental "new version"; it is a no-op, not history.
   */
  unchanged: boolean;
}

export const replaceDocumentContent = async (args: {
  documentId: string;
  teamId: string;
  organizationId: string;
  bytes: Uint8Array;
  operation: "edit" | "replace" | "restore";
  actorContext: DocumentVersionActorContext;
  /**
   * Rejects the write when the document moved since the caller read it —
   * optimistic concurrency for the authored editor, so a human and the agent
   * saving at once produces a 409 instead of a silent overwrite. Omit for
   * unconditional writes.
   */
  expectedUpdatedAt?: Date;
  /**
   * Content hash the caller last saw — the agent's half of read-before-write.
   *
   * `expectedUpdatedAt` serves the browser editor, which holds a row it fetched.
   * An agent holds TEXT, and what invalidates its edit anchors is the content
   * changing, not the row's timestamp moving. Hashing what it read is therefore
   * the honest check: immune to clock precision, and true even if the same
   * content was rewritten identically (in which case the anchors still hold and
   * refusing would be wrong).
   */
  expectedFileHash?: string;
  /**
   * Declared type of the incoming bytes. Must match the document's — a version
   * is the same document with new content, so a PDF cannot become a
   * spreadsheet (their S3 keys differ by extension, and the mirror record's
   * extracted fields would describe a file that no longer exists). Changing
   * format means creating a new document.
   */
  mimeType?: string;
}): Promise<ReplaceContentResult> => {
  const { documentId, teamId, organizationId, bytes, operation, actorContext } =
    args;

  const document = await db.query.documents.findFirst({
    where: { id: documentId, teamId },
  });
  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }
  if (args.mimeType && args.mimeType !== document.mimeType) {
    return throwHttpError(
      400,
      createApiError(
        ERROR_CODES.DOCUMENT_TYPE_MISMATCH,
        `A new version must keep the document's type (${document.mimeType}); upload ${args.mimeType} as a new document instead.`,
      ),
    );
  }
  if (
    args.expectedUpdatedAt &&
    document.updatedAt.getTime() !== args.expectedUpdatedAt.getTime()
  ) {
    return throwHttpError(
      409,
      createApiError(
        ERROR_CODES.DOCUMENT_STALE,
        "This document changed since you opened it. Reload to see the latest version before saving.",
      ),
    );
  }
  if (args.expectedFileHash && args.expectedFileHash !== document.fileHash) {
    return throwHttpError(
      409,
      createApiError(
        ERROR_CODES.DOCUMENT_STALE,
        "This document changed since you read it. Read it again before editing — your anchors were composed against text that is no longer there.",
      ),
    );
  }

  const fileHash = Bun.SHA256.hash(bytes, "hex");
  const current = await getCurrentVersion(document);

  // Identical bytes — nothing happened. Guarding here rather than at each call
  // site is what keeps "restore the version I'm already on" and "re-upload the
  // same file" from minting empty history.
  if (fileHash === document.fileHash) {
    return { document, version: current, unchanged: true };
  }

  const originalKey = buildDocumentOriginalKey(
    documentId,
    document.originalFilename,
  );
  const coalesce = shouldCoalesce({
    current,
    operation,
    actorContext,
    now: Date.now(),
  });

  // Archive the outgoing bytes and repoint their row BEFORE overwriting the
  // live key — the one ordering in which no crash loses content. Skipped when
  // coalescing: the version being folded into is the one we are replacing.
  if (!coalesce) {
    const archiveKey = buildDocumentVersionKey(
      documentId,
      current.versionNumber,
      document.originalFilename,
    );
    await copyObject({
      sourceKey: originalKey,
      destinationKey: archiveKey,
      contentType: document.mimeType,
      metadata: { documentId, organizationId, teamId },
    });
    await db
      .update(documentVersions)
      .set({ storageKey: archiveKey })
      .where(eq(documentVersions.id, current.id));
  }

  await uploadToS3({
    buffer: bytes,
    key: originalKey,
    contentType: document.mimeType,
    documentId,
    organizationId,
    teamId,
  });

  const reprocess = needsReprocessing(document.mimeType);

  // Resolved before the transaction: the mirror is what carries this event
  // into the document's activity timeline, and it does not move during a
  // replacement. Null for a document whose mirror was never created — the
  // event is still journalled, only without a record to hang it on.
  const mirrorRecordId = await resolveDocumentRecordId({ documentId, teamId });

  const { updated, version } = await withVersionNumberConflictAsStale(
    documentId,
    db.transaction(async (tx) => {
      const [updatedDocument] = await tx
        .update(documents)
        .set({
          fileSize: bytes.length,
          fileHash,
          // Derived artefacts (thumbnail, OCR sidecar, extracted fields) now
          // describe bytes that are gone, so the document re-enters the pipeline.
          // Markdown has no derived artefacts and stays `ready`.
          ...(reprocess ? { status: "processing" as const } : {}),
        })
        .where(eq(documents.id, documentId))
        .returning();
      if (!updatedDocument) {
        throw new Error(`Document ${documentId} vanished mid-replace`);
      }

      const [versionRow] = coalesce
        ? await tx
            .update(documentVersions)
            .set({ fileSize: bytes.length, fileHash, createdAt: new Date() })
            .where(eq(documentVersions.id, current.id))
            .returning()
        : await tx
            .insert(documentVersions)
            .values({
              documentId,
              teamId,
              versionNumber: current.versionNumber + 1,
              operation,
              storageKey: originalKey,
              mimeType: document.mimeType,
              fileSize: bytes.length,
              fileHash,
              byUserId: actorContext.userId,
              byActor: actorContext.actor,
              byConversationId: actorContext.conversationId ?? null,
            })
            .returning();
      if (!versionRow) {
        throw new Error(
          `Failed to record a version for document ${documentId}`,
        );
      }

      // Versions occupy real storage: the archive stays alongside the live
      // original. Coalescing overwrites in place, so only the size delta counts.
      const addedBytes = coalesce
        ? bytes.length - current.fileSize
        : bytes.length;
      await tx
        .update(teamSettings)
        .set({
          storageUsedGb: sql`GREATEST(0, ${teamSettings.storageUsedGb} + ${addedBytes / 1024 ** 3})`,
        })
        .where(eq(teamSettings.teamId, teamId));

      // Journalled in the SAME transaction as the version row — a workflow that
      // wakes on "this document has new content" must never fire for a write
      // that rolled back, nor miss one that committed.
      //
      // A coalesced save deliberately re-emits under the version's existing
      // number: the `dedupKey` then matches the entry already there, so ten
      // seconds of typing produce one journal line, exactly as they produce one
      // version. `restore` is the same event as an edit — the bytes changed, and
      // that is the whole fact a subscriber acts on.
      await emitDomainEvent({
        tx,
        organizationId,
        teamId,
        type: "document.revised",
        actor: journalActorFor(actorContext),
        subjectType: "document",
        subjectRecordId: mirrorRecordId,
        payload: {
          documentId,
          filename: updatedDocument.originalFilename,
          folderId: updatedDocument.folderId,
          versionNumber: versionRow.versionNumber,
          operation,
        },
        dedupKey: `document.revised:${documentId}:${versionRow.versionNumber.toString()}`,
        ...(mirrorRecordId
          ? { recordLinks: [{ recordId: mirrorRecordId, role: "subject" }] }
          : {}),
      });

      return { updated: updatedDocument, version: versionRow };
    }),
  );

  const freedBytes = await trimDocumentVersions(documentId);
  if (freedBytes > 0) {
    await db
      .update(teamSettings)
      .set({
        storageUsedGb: sql`GREATEST(0, ${teamSettings.storageUsedGb} - ${freedBytes / 1024 ** 3})`,
      })
      .where(eq(teamSettings.teamId, teamId));
  }

  if (reprocess) {
    try {
      await enqueueDocumentProcessing({
        documentId,
        organizationId,
        teamId,
        originalKey,
        metadata: {
          id: documentId,
          folderId: updated.folderId,
          originalFilename: updated.originalFilename,
          fileSize: updated.fileSize,
          mimeType: updated.mimeType,
          fileHash: updated.fileHash,
        },
        // Re-extract against THESE bytes rather than cloning a same-hash
        // sibling's cached results.
        force: true,
      });
    } catch (error) {
      // Deliberately NOT `finalizeFailedDocument`: that path deletes the S3
      // objects and refunds storage, which would destroy a document whose new
      // content is already safely written. Only the derived artefacts are
      // stale, so the document goes back to `ready` and the caller is told.
      await db
        .update(documents)
        .set({ status: "ready" })
        .where(eq(documents.id, documentId));
      throw error;
    }
  } else {
    await scheduleDocumentVectorRefresh({
      documentId,
      teamId,
      organizationId,
    });
  }

  return { document: updated, version, unchanged: false };
};
