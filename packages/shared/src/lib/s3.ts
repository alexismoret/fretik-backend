import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
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
}): Promise<void> => {
  await client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
      Metadata: args.metadata,
    }),
  );
};

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
 * List every key under a prefix. Handles paginated continuation via
 * `NextContinuationToken`. Returns `[]` on error so callers can treat
 * the result as "nothing to do".
 */
export const listObjects = async (prefix: string): Promise<string[]> => {
  const keys: string[] = [];
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
        if (typeof entry.Key === "string") keys.push(entry.Key);
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
  return keys;
};

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

export const getPresignedUrl = async (
  key: string,
  expiresIn = 3600,
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: key,
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
