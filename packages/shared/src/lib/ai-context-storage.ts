import { deleteObject, getObjectBytes, putObject } from "./s3";

/**
 * Shared S3 layer for AI context-file binaries (the persistent
 * `aiContextFiles` rows — Settings → Chatbot context → Upload).
 * Mirrors the chat-files / chatbot-sessions split: each context file
 * has an **original** key (raw bytes the user uploaded) and an
 * optional **sidecar** key (`.md` carrying the OCR / spreadsheet /
 * markdown extraction) so the conversation-turn hydrator can
 * write both into the sandbox's `/workspace/context/` and the
 * regular `read` tool serves them just like any other file.
 *
 * Pattern reference: `lib/chatbot-session-storage.ts` — same
 * primitives (putObject / getObjectBytes / deleteObject), same
 * single-responsibility wrapper, just scoped to `(profileId, fileId)`
 * instead of `(conversationId, basename)`.
 *
 * Key namespace stays `ai-context/` so a bucket listing tells
 * operators at a glance what the key is for. Originals get the
 * file's real extension; sidecars are always `.md`.
 */

const S3_CONTEXT_PREFIX = "ai-context";

export const buildContextOriginalKey = (
  profileId: string,
  fileId: string,
  extWithDot: string,
): string => `${S3_CONTEXT_PREFIX}/${profileId}/${fileId}${extWithDot}`;

export const buildContextSidecarKey = (
  profileId: string,
  fileId: string,
): string => `${S3_CONTEXT_PREFIX}/${profileId}/${fileId}.md`;

/**
 * Upload the OCR / extraction sidecar (`.md`). Errors are logged and
 * swallowed — the calling extraction path catches its own
 * write-then-update failures and surfaces them on the row, so we
 * keep this helper crash-resistant for the common case where S3 is
 * just transiently slow.
 */
export const uploadContextSidecar = async (
  profileId: string,
  fileId: string,
  markdown: string,
): Promise<void> => {
  const key = buildContextSidecarKey(profileId, fileId);
  await putObject({
    key,
    body: new TextEncoder().encode(markdown),
    contentType: "text/markdown; charset=utf-8",
    metadata: { profileId },
  });
};

/**
 * Read the original bytes back from S3. Returns `null` on miss or
 * error so the conversation hydrator can degrade gracefully (the
 * file simply won't appear in `/tmp/.../context/` for that turn).
 */
export const readContextOriginal = async (
  profileId: string,
  fileId: string,
  extWithDot: string,
): Promise<Uint8Array | null> =>
  getObjectBytes(buildContextOriginalKey(profileId, fileId, extWithDot));

/**
 * Read the sidecar markdown back from S3. Returns `null` when the
 * sidecar is absent (text-like files don't have one, and pre-refonte
 * rows haven't been backfilled yet — see the lazy-backfill path in
 * `@fretik/ai/src/lib/context-files-hydration.ts`).
 */
export const readContextSidecar = async (
  profileId: string,
  fileId: string,
): Promise<Uint8Array | null> =>
  getObjectBytes(buildContextSidecarKey(profileId, fileId));

/**
 * Delete the original. Used by the `services/ai-context/delete.ts`
 * path. Best-effort: errors are logged inside `deleteObject` but
 * never re-raised — the row is already gone in DB.
 */
export const deleteContextOriginal = async (
  profileId: string,
  fileId: string,
  extWithDot: string,
): Promise<void> => {
  await deleteObject(buildContextOriginalKey(profileId, fileId, extWithDot));
};

/**
 * Delete the sidecar. Caller is responsible for checking whether one
 * exists first — only call when `aiContextFiles.hasMarkdown` was
 * `true`. Best-effort.
 */
export const deleteContextSidecar = async (
  profileId: string,
  fileId: string,
): Promise<void> => {
  await deleteObject(buildContextSidecarKey(profileId, fileId));
};
