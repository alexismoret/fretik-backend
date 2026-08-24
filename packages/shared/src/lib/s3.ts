import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ObjectCannedACL,
  PutObjectCommand,
  S3Client,
  waitUntilObjectNotExists,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Bucket = process.env.S3_BUCKET;
const s3Url = process.env.S3_URL;
const s3Region = process.env.S3_REGION;
const s3AccessKeyId = process.env.SCW_ACCESS_KEY;
const s3SecretAccessKey = process.env.SCW_SECRET_KEY;

if (!s3Bucket || !s3Url || !s3Region || !s3AccessKeyId || !s3SecretAccessKey) {
  throw "Missing S3 en vars";
}

const client = new S3Client({
  endpoint: s3Url,
  region: s3Region,
  credentials: {
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
  },
  forcePathStyle: true,
});

// ============================================================ //
// GENERIC S3 PRIMITIVES                                          //
// ============================================================ //

/**
 * Raw PUT of an object. Lets callers pass optional `contentType` and
 * S3 user-metadata. `uploadToS3` (documents pipeline) and
 * `uploadSessionFile` (chatbot sessions) both delegate here so there
 * is a single S3 code path across the monorepo.
 */
export const putObject = async (args: {
  key: string;
  body: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
  /**
   * Canned ACL. Pass `"public-read"` for assets served directly to the
   * browser (avatars, org logos) under the `public/` prefix. Omit for
   * private objects (documents, sessions) read through presigned URLs.
   */
  acl?: ObjectCannedACL;
}): Promise<void> => {
  await client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
      Metadata: args.metadata,
      ACL: args.acl,
    }),
  );
};

/**
 * Permanent, public URL for an object stored under the `public/` prefix.
 * Mirrors the path-style addressing the bucket is configured for
 * (`forcePathStyle`), e.g. `https://s3.<region>.scw.cloud/<bucket>/<key>`.
 * Only meaningful for objects uploaded with `acl: "public-read"`.
 */
export const publicUrl = (key: string): string => `${s3Url}/${s3Bucket}/${key}`;

/**
 * Raw GET of an object. Returns the S3 `Body` stream (or `null` when
 * the SDK omitted it). The documents pipeline uses this directly;
 * wrappers that need bytes in-memory should call `getObjectBytes`.
 */
export const getObject = async (key: string) => {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    }),
  );
  return response.Body;
};

/**
 * Read a full object into memory as a `Uint8Array`. Returns `null`
 * on any error (missing object, transient network failure); callers
 * that need to distinguish the two should catch at the raw `getObject`
 * layer instead. Suitable for small-to-medium payloads that fit
 * comfortably in RAM (chatbot session files are capped at 15 MB).
 */
export const getObjectBytes = async (
  key: string,
): Promise<Uint8Array | null> => {
  try {
    const body = await getObject(key);
    if (!body) return null;
    return new Uint8Array(await body.transformToByteArray());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/NoSuchKey|NotFound/i.test(message)) {
      console.warn(`[s3] getObjectBytes failed for ${key}:`, message);
    }
    return null;
  }
};

/**
 * Server-side object copy within the bucket — the bytes never transit the
 * caller's process. Used to hand a chat-file attachment off to the Drive
 * pipeline (chatbot Save-on-drive) without downloading + re-uploading it
 * in the AI service. Pass `metadata` to overwrite the S3 user-metadata on
 * the copy (defaults to inheriting the source's).
 */
export const copyObject = async (args: {
  sourceKey: string;
  destinationKey: string;
  contentType?: string;
  metadata?: Record<string, string>;
}): Promise<void> => {
  await client.send(
    new CopyObjectCommand({
      Bucket: s3Bucket,
      Key: args.destinationKey,
      CopySource: encodeURIComponent(`${s3Bucket}/${args.sourceKey}`),
      ...(args.contentType ? { ContentType: args.contentType } : {}),
      ...(args.metadata
        ? { Metadata: args.metadata, MetadataDirective: "REPLACE" }
        : {}),
    }),
  );
};

export interface S3ObjectEntry {
  key: string;
  size: number;
  lastModified: Date | null;
}

/**
 * List every object under a prefix WITH its size and mtime. Handles paginated
 * continuation via `NextContinuationToken`. Returns `[]` on error so callers
 * can treat the result as "nothing to do".
 *
 * The listing already carries size and mtime — `listObjects` below throws them
 * away, which is right for the callers that only need to enumerate or delete,
 * and wrong for anything showing a file to a person. Getting them any other way
 * would be one HEAD request per object.
 */
export const listObjectsDetailed = async (
  prefix: string,
): Promise<S3ObjectEntry[]> => {
  const entries: S3ObjectEntry[] = [];
  let continuationToken: string | undefined;
  try {
    do {
      // Sequential by design: `NextContinuationToken` is only known
      // after the previous response, so the loop iterations can't be
      // parallelised.
      // eslint-disable-next-line no-await-in-loop
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const entry of response.Contents ?? []) {
        if (typeof entry.Key !== "string") continue;
        entries.push({
          key: entry.Key,
          size: entry.Size ?? 0,
          lastModified: entry.LastModified ?? null,
        });
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
  } catch (err) {
    console.warn(
      `[s3] listObjects failed for ${prefix}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
  return entries;
};

/** Keys only — the shape every enumerate-and-act caller wants. */
export const listObjects = async (prefix: string): Promise<string[]> =>
  (await listObjectsDetailed(prefix)).map((entry) => entry.key);

/**
 * Best-effort delete of a single object. Failures are logged and
 * swallowed — the caller already holds whatever authoritative state
 * it was trying to stay in sync with.
 */
export const deleteObject = async (key: string): Promise<void> => {
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      }),
    );
  } catch (err) {
    console.warn(
      `[s3] deleteObject failed for ${key}:`,
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * Bulk delete for a batch of keys. AWS limits a `DeleteObjects`
 * request to 1000 keys; callers that might exceed that are expected
 * to batch. No waiters — this runs in hot cleanup paths where we
 * accept eventual consistency.
 */
export const deleteObjects = async (keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  try {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: s3Bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
        },
      }),
    );
  } catch (err) {
    console.warn(
      `[s3] deleteObjects failed (${keys.length.toString()} keys):`,
      err instanceof Error ? err.message : err,
    );
  }
};

interface PresignedUrlOptions {
  /**
   * Force the object to download under this filename instead of being
   * rendered inline. Signed into the URL as `response-content-disposition`,
   * which S3 (and Scaleway's S3-compatible API) echoes back as the response
   * `Content-Disposition`.
   *
   * Needed because the object's stored Content-Type decides the default:
   * an attachment uploaded as `image/png` or `application/pdf` renders in
   * the tab instead of downloading. Overriding at presign time keeps the
   * stored metadata honest (previews still work — they just don't pass
   * this) while giving download actions a deterministic outcome.
   */
  downloadFilename?: string;
}

/**
 * RFC 5987 / RFC 6266 `Content-Disposition` for an arbitrary filename.
 *
 * Two parameters on purpose: bare `filename` is ASCII-only per the RFC, so
 * anything else (accents, CJK — routine for user-supplied and agent-generated
 * names alike) must also travel as percent-encoded UTF-8 in `filename*`.
 * Clients that understand `filename*` prefer it; the rest fall back to the
 * sanitised ASCII form. Quotes and backslashes are stripped from the fallback
 * so they cannot terminate the quoted-string early.
 */
const contentDispositionFor = (filename: string): string => {
  const asciiFallback = filename
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

export const getPresignedUrl = async (
  key: string,
  expiresIn = 3600,
  options: PresignedUrlOptions = {},
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    ...(options.downloadFilename !== undefined
      ? {
          ResponseContentDisposition: contentDispositionFor(
            options.downloadFilename,
          ),
        }
      : {}),
  });

  return getSignedUrl(client, command, { expiresIn });
};

// ============================================================ //
// DOCUMENTS-PIPELINE HELPERS                                      //
// ============================================================ //

interface UploadToS3Data {
  buffer: Uint8Array;
  key: string;
  contentType: string;
  documentId: string;
  organizationId: string;
  teamId: string;
  /**
   * Marks the object as ephemeral (deleted once its short-lived consumer is
   * done — e.g. Mistral OCR has fetched a converted PDF for pre-extraction).
   * The flag is written to S3 user-metadata (`x-amz-meta-temporary`) so a
   * crash that skips the cleanup still leaves a queryable trail for a
   * janitor job to reap orphans.
   */
  temporary?: boolean;
}

export const uploadToS3 = async (data: UploadToS3Data): Promise<string> => {
  const metadata: Record<string, string> = {
    documentId: data.documentId,
    organizationId: data.organizationId,
    teamId: data.teamId,
  };
  if (data.temporary) {
    metadata.temporary = "true";
  }

  await putObject({
    key: data.key,
    body: data.buffer,
    contentType: data.contentType,
    metadata,
  });

  return data.key;
};

export const getFileFromS3 = (key: string) => getObject(key);

/**
 * Delete a list of document keys from the documents pipeline and
 * wait for the propagation (documents have user-visible caches that
 * need the deletion to be consistent before the handler returns).
 */
export const deleteFilesFromS3 = async (keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  await deleteObjects(keys);
  await Promise.all(
    keys.map((Key) =>
      waitUntilObjectNotExists(
        { client: client, maxWaitTime: 10 },
        { Bucket: s3Bucket, Key },
      ),
    ),
  );
};
