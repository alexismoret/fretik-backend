import db from "../../db";
import { aiChatFiles } from "../../db/schema";
import { expectsSidecar } from "../../file-types";
import { extractChatFileSnapshot } from "../../lib/chat-file-snapshot";
import {
  sanitizeSessionPath,
  uploadSessionFile,
} from "../../lib/chatbot-session-storage";

export interface RunAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Store trigger files on a fresh run conversation so the agent can read them:
 * bytes → the S3 session folder (`attachments/<name>`), metadata → an
 * `ai_chat_files` row (`status: "ready"`, anonymous uploader). Filenames are
 * sanitized + deduped so the `(conversationId, filename)` unique constraint
 * holds and the stored name maps 1:1 to the on-disk basename that
 * `buildAttachedFilesBlock` renders into `<file_attachments>`.
 *
 * Called from `createWorkflowRun` BEFORE the Trigger.dev task fires, so the
 * files exist by the time the first turn assembles its context. Generic — the
 * form trigger and any future attachment-bearing trigger (e.g. email) reuse it.
 */
export const attachRunFiles = async (
  conversationId: string,
  attachments: RunAttachment[],
): Promise<void> => {
  const taken = new Set<string>();
  for (const att of attachments) {
    const base = sanitizeSessionPath(att.filename) || "file";
    let name = base;
    const dot = base.lastIndexOf(".");
    for (let i = 2; taken.has(name); i += 1) {
      name =
        dot > 0
          ? `${base.slice(0, dot)}_${i.toString()}${base.slice(dot)}`
          : `${base}_${i.toString()}`;
    }
    taken.add(name);

    await uploadSessionFile(
      conversationId,
      `attachments/${name}`,
      att.bytes,
      att.mimeType,
    );
    // Same row shape a chat upload writes (`ai/services/chat-files/upload`).
    // Without the hash, these files missed the content-addressed extraction
    // cache and `read` had to backfill one on the fly; without the snapshot,
    // their `<attached_file>` block arrived blind.
    const snapshot = await extractChatFileSnapshot(
      att.bytes,
      att.mimeType,
      undefined,
      name,
    ).catch(() => undefined);

    await db.insert(aiChatFiles).values({
      conversationId,
      uploadedById: null,
      filename: name,
      mimeType: att.mimeType,
      size: att.bytes.byteLength,
      fileHash: Bun.SHA256.hash(att.bytes, "hex"),
      hasMarkdown: expectsSidecar(att.mimeType, name),
      ...(snapshot ? { snapshot } : {}),
      status: "ready",
    });
  }
};
