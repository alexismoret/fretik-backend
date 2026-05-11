import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import {
  deleteSessionFile,
  sanitizeSessionPath,
} from "@fretik/shared/lib/chatbot-session-storage";
import { and, inArray, isNull, lt } from "drizzle-orm";

/**
 * Orphan reaper. An `ai_chat_files` row is orphaned when its parent
 * user message has not been persisted yet — `messageId IS NULL` —
 * and the created-at is older than `ORPHAN_AGE_MS` (24h by default).
 * Runs once a day under a BullMQ cron schedule (`@fretik/worker`).
 *
 * For each orphan we:
 *  1. Delete the S3 session file at `attachments/{filename}` (the
 *     workspace-relative path used by the sandbox-first conversation
 *     storage façade).
 *  2. Delete any `{basename}.md` sidecar created by the OCR
 *     preprocessor.
 *  3. Delete the row.
 *
 * We only touch S3 — the sandbox itself naturally expires under E2B's
 * 24h TTL, so there's nothing to reap there. Per-file failures are
 * logged and skipped — one stuck S3 object never blocks the rest of
 * the batch. The query is narrowed by the partial index
 * `ai_chat_files_orphans_idx` so it runs in milliseconds even on
 * million-row tables.
 */

const DEFAULT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;

const ATTACHMENTS_PREFIX = "attachments";

const sidecarFilename = (filename: string): string => {
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return `${base}.md`;
};

const buildAttachmentPath = (filename: string): string =>
  `${ATTACHMENTS_PREFIX}/${sanitizeSessionPath(filename)}`;

export interface OrphanCleanupResult {
  scanned: number;
  deleted: number;
  failed: number;
}

export const runOrphanCleanup = async (
  options: {
    maxAgeMs?: number;
  } = {},
): Promise<OrphanCleanupResult> => {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_ORPHAN_AGE_MS;
  const cutoff = new Date(Date.now() - maxAgeMs);

  const orphans = await db
    .select({
      id: aiChatFiles.id,
      conversationId: aiChatFiles.conversationId,
      filename: aiChatFiles.filename,
      hasMarkdown: aiChatFiles.hasMarkdown,
    })
    .from(aiChatFiles)
    .where(
      and(isNull(aiChatFiles.messageId), lt(aiChatFiles.createdAt, cutoff)),
    );

  if (orphans.length === 0) {
    return { scanned: 0, deleted: 0, failed: 0 };
  }

  const deletedIds: string[] = [];
  let failed = 0;

  for (const orphan of orphans) {
    try {
      // Sequential by design: each orphan reap does at most two
      // S3 calls (file + optional sidecar); running 20+ in
      // parallel would risk rate-limiting Scaleway on replicas
      // that accumulated many abandoned drafts overnight. This is
      // a nightly janitor — latency is not a constraint.
      // eslint-disable-next-line no-await-in-loop
      await deleteSessionFile(
        orphan.conversationId,
        buildAttachmentPath(orphan.filename),
      );
      if (orphan.hasMarkdown) {
        // eslint-disable-next-line no-await-in-loop
        await deleteSessionFile(
          orphan.conversationId,
          buildAttachmentPath(sidecarFilename(orphan.filename)),
        );
      }
      deletedIds.push(orphan.id);
    } catch (err) {
      failed += 1;
      console.warn(
        `[chat-files/orphan-cleanup] failed to reap ${orphan.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (deletedIds.length > 0) {
    await db.delete(aiChatFiles).where(inArray(aiChatFiles.id, deletedIds));
  }

  console.log(
    `[chat-files/orphan-cleanup] scanned=${orphans.length.toString()} deleted=${deletedIds.length.toString()} failed=${failed.toString()}`,
  );

  return {
    scanned: orphans.length,
    deleted: deletedIds.length,
    failed,
  };
};
