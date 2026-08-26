import {
  deleteObject,
  deleteObjects,
  getObjectBytes,
  getPresignedUrl,
  listObjects,
  listObjectsDetailed,
  putObject,
} from "./s3";

/**
 * Shared S3 layer for chatbot conversation session folders
 * (`chatbot-sessions/{conversationId}/{basename}`). Thin wrapper over
 * the generic `s3.ts` primitives with session-specific key building
 * and segment sanitisation.
 *
 * Both @fretik/ai (chatbot hot path: reads, writes, presign for OCR,
 * hydration into /tmp) and @fretik/api (conversation DELETE handler)
 * consume this layer directly — no internal HTTP hop.
 *
 * There is no local hot cache: S3 and the sandbox's `/workspace` are
 * the only two places these bytes live.
 */

const S3_SESSION_PREFIX = "chatbot-sessions";

/**
 * Restrict path segments to a safe character set so a rogue
 * `conversationId` or `basename` cannot escape the session prefix
 * via `..` or absolute paths. UUIDs, nanoids, and AI SDK tool call
 * ids all pass through unchanged.
 *
 * Single-segment only: callers passing nested paths (e.g.
 * `attachments/foo.pdf`) should use `sanitizeSessionPath` instead,
 * which preserves the slash separators.
 */
export const sanitizeSessionSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Path-aware variant of `sanitizeSessionSegment`. Splits on `/`,
 * sanitises each segment individually, drops empty segments
 * (collapses leading `/` and `//`) plus `.` and `..` (no traversal),
 * and rejoins with `/`. Lets callers store nested keys like
 * `attachments/foo.pdf` or `outputs/persisted/abc.txt` without
 * losing the path structure or letting a hostile filename escape.
 *
 * Backward compatible: a flat basename (no slashes) returns the
 * same result as `sanitizeSessionSegment`.
 */
export const sanitizeSessionPath = (path: string): string =>
  path
    .split("/")
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
    .map(sanitizeSessionSegment)
    .join("/");

export const buildSessionKey = (
  conversationId: string,
  pathOrBasename: string,
): string =>
  `${S3_SESSION_PREFIX}/${sanitizeSessionSegment(conversationId)}/${sanitizeSessionPath(pathOrBasename)}`;

export const buildSessionPrefix = (conversationId: string): string =>
  `${S3_SESSION_PREFIX}/${sanitizeSessionSegment(conversationId)}/`;

/**
 * Upload a single file to the session folder. Failures are logged
 * inside `putObject` and re-raised only for internal-error cases; we
 * still wrap in try/catch so the caller's current turn keeps working
 * even if S3 is flaky.
 *
 * `pathOrBasename` may be either a flat basename (`foo.pdf`,
 * legacy callers) or a nested path under the session root
 * (`attachments/foo.pdf`, `outputs/persisted/abc.txt`).
 *
 * `contentType` should be passed whenever the caller has it (e.g.
 * `file.type` from a multipart upload, `text/markdown` for OCR
 * sidecars). Without it, S3 stores the object as
 * `application/octet-stream`, which breaks downstream consumers like
 * Mistral OCR.
 */
export const uploadSessionFile = async (
  conversationId: string,
  pathOrBasename: string,
  content: string | Uint8Array,
  contentType?: string,
): Promise<void> => {
  const key = buildSessionKey(conversationId, pathOrBasename);
  try {
    await putObject({
      key,
      body:
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      contentType,
    });
  } catch (err) {
    console.warn(
      `[chatbot-session-storage] upload failed for ${key}:`,
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * Read a session file's raw bytes. Returns `null` on miss or error
 * so callers can fall back to whatever local source they still have.
 */
export const readSessionFile = async (
  conversationId: string,
  pathOrBasename: string,
): Promise<Uint8Array | null> =>
  getObjectBytes(buildSessionKey(conversationId, pathOrBasename));

/**
 * List every flat basename stored at the root of a session folder.
 *
 * **Legacy semantics**: returns ONLY top-level basenames, hiding
 * anything nested under a subdirectory (`attachments/...`,
 * `outputs/...`). Kept as-is for the legacy callers that assume a flat
 * per-conversation layout. New callers using the sandbox-first
 * conversation-storage façade should use `listSessionPaths` to get the
 * full nested tree.
 */
export const listSessionFiles = async (
  conversationId: string,
): Promise<string[]> => {
  const prefix = buildSessionPrefix(conversationId);
  const keys = await listObjects(prefix);
  return keys
    .map((key) => key.slice(prefix.length))
    .filter((basename) => basename.length > 0 && !basename.includes("/"));
};

/**
 * List every key stored under a session, returning paths relative
 * to the session root (e.g. `attachments/foo.pdf`,
 * `outputs/persisted/abc.txt`). Optional `subdirPrefix` narrows the
 * listing to a single subdirectory like `attachments` or `outputs`.
 *
 * Used by the sandbox-first conversation storage to enumerate
 * everything we have to restore on a fresh sandbox after expiry.
 */
export const listSessionPaths = async (
  conversationId: string,
  subdirPrefix?: string,
): Promise<string[]> => {
  const sessionPrefix = buildSessionPrefix(conversationId);
  const fullPrefix =
    subdirPrefix !== undefined && subdirPrefix.length > 0
      ? `${sessionPrefix}${sanitizeSessionPath(subdirPrefix)}/`
      : sessionPrefix;
  const keys = await listObjects(fullPrefix);
  return keys
    .map((key) => key.slice(sessionPrefix.length))
    .filter((path) => path.length > 0);
};

export interface SessionFileEntry {
  /** Session-relative path, e.g. `outputs/report.xlsx`. */
  path: string;
  size: number;
  lastModified: Date | null;
}

/**
 * Same listing as `listSessionPaths`, keeping the size and mtime S3 already
 * returns — what anything SHOWING these files to a person needs.
 */
export const listSessionEntries = async (
  conversationId: string,
  subdirPrefix?: string,
): Promise<SessionFileEntry[]> => {
  const sessionPrefix = buildSessionPrefix(conversationId);
  const fullPrefix =
    subdirPrefix !== undefined && subdirPrefix.length > 0
      ? `${sessionPrefix}${sanitizeSessionPath(subdirPrefix)}/`
      : sessionPrefix;
  const entries = await listObjectsDetailed(fullPrefix);
  return entries
    .map((entry) => ({
      path: entry.key.slice(sessionPrefix.length),
      size: entry.size,
      lastModified: entry.lastModified,
    }))
    .filter((entry) => entry.path.length > 0);
};

/**
 * Delete a single file from the session folder (best-effort).
 */
export const deleteSessionFile = async (
  conversationId: string,
  pathOrBasename: string,
): Promise<void> => {
  await deleteObject(buildSessionKey(conversationId, pathOrBasename));
};

/**
 * Delete every file under a conversation's session folder. Called
 * from the API conversation DELETE handler after the DB cascade has
 * reaped `ai_chat_files` rows. Uses the bulk `deleteObjects` to stay
 * fast on folders with many files; per-object failures are logged
 * and skipped.
 */
export const deleteSessionFolder = async (
  conversationId: string,
): Promise<void> => {
  const basenames = await listSessionFiles(conversationId);
  if (basenames.length === 0) return;
  const keys = basenames.map((basename) =>
    buildSessionKey(conversationId, basename),
  );
  await deleteObjects(keys);
};

/**
 * Generate a short-lived presigned GET URL for a session file. Used
 * by the Phase 11 chat-file preprocessor to hand Mistral OCR a URL
 * it can fetch without bucket credentials. Default expiry is 10
 * minutes.
 */
export const getSessionFilePresignedUrl = (
  conversationId: string,
  basename: string,
  expiresIn = 600,
): Promise<string> =>
  getPresignedUrl(buildSessionKey(conversationId, basename), expiresIn);
