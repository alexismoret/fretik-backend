import { AwsClient } from "aws4fetch";

const s3Bucket = process.env.S3_BUCKET;
const s3Url = process.env.S3_URL;
const s3Region = process.env.S3_REGION;
const s3AccessKeyId = process.env.SCW_ACCESS_KEY;
const s3SecretAccessKey = process.env.SCW_SECRET_KEY;

if (!s3Bucket || !s3Url || !s3Region || !s3AccessKeyId || !s3SecretAccessKey) {
  throw "Missing S3 en vars";
}

const endpoint = s3Url.replace(/\/$/, "");

/**
 * Bun's native S3 client. Serves every operation it supports — GET, DELETE,
 * LIST, HEAD and presigning — with no dependency and no JS-side request
 * marshalling.
 *
 * Path-style addressing (`{endpoint}/{bucket}/{key}`) is what an explicit
 * `endpoint` gives you by default, which is what the bucket is configured for
 * and what `publicUrl` below hard-codes.
 */
const s3 = new Bun.S3Client({
  accessKeyId: s3AccessKeyId,
  secretAccessKey: s3SecretAccessKey,
  bucket: s3Bucket,
  region: s3Region,
  endpoint,
});

/**
 * SigV4 signer for the three operations Bun's client cannot express:
 * user-metadata on PUT (`x-amz-meta-*`), server-side CopyObject, and batch
 * DeleteObjects. aws4fetch is ~2 KB with no dependencies — it signs a `Request`
 * and hands it to `fetch`, nothing more.
 */
const signer = new AwsClient({
  accessKeyId: s3AccessKeyId,
  secretAccessKey: s3SecretAccessKey,
  region: s3Region,
  service: "s3",
});

/**
 * Percent-encode a key for use in a URL path. Segment by segment: `/` is the
 * path separator S3 uses to fake directories and must survive, everything else
 * (spaces, accents, `+`, `?`) must not.
 */
const encodeKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

const objectUrl = (key: string): string =>
  `${endpoint}/${s3Bucket}/${encodeKey(key)}`;

/** `x-amz-meta-*` headers for a metadata map. */
const metadataHeaders = (
  metadata: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k}`, v]),
  );

/** Throw with the response body, which is where S3 puts the actual reason. */
const assertOk = async (response: Response, what: string): Promise<void> => {
  if (response.ok) return;
  throw new Error(
    `[s3] ${what} failed (${response.status.toString()}): ${await response.text()}`,
  );
};

// ============================================================ //
// GENERIC S3 PRIMITIVES                                          //
// ============================================================ //

/**
 * Canned ACLs S3 accepts. Previously imported from `@aws-sdk/client-s3`;
 * inlined so the type does not drag a 15 MB SDK back in for one string union.
 */
export type ObjectCannedACL =
  | "private"
  | "public-read"
  | "public-read-write"
  | "authenticated-read"
  | "aws-exec-read"
  | "bucket-owner-read"
  | "bucket-owner-full-control";

/**
 * Raw PUT of an object. Lets callers pass optional `contentType` and
 * S3 user-metadata. `uploadToS3` (documents pipeline) and
 * `uploadSessionFile` (chatbot sessions) both delegate here so there
 * is a single S3 code path across the monorepo.
 *
 * Signed by hand rather than through `Bun.S3Client.write`: Bun has no way to
 * set `x-amz-meta-*` (oven-sh/bun#19301), and the documents pipeline stamps
 * every object with its document/org/team ids.
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
  const response = await signer.fetch(objectUrl(args.key), {
    method: "PUT",
    body: args.body,
    headers: {
      ...(args.contentType ? { "content-type": args.contentType } : {}),
      ...(args.acl ? { "x-amz-acl": args.acl } : {}),
      ...(args.metadata ? metadataHeaders(args.metadata) : {}),
    },
  });
  await assertOk(response, `putObject ${args.key}`);
};

/**
 * Permanent, public URL for an object stored under the `public/` prefix.
 * Mirrors the path-style addressing the bucket is configured for,
 * e.g. `https://s3.<region>.scw.cloud/<bucket>/<key>`.
 * Only meaningful for objects uploaded with `acl: "public-read"`.
 */
export const publicUrl = (key: string): string => `${s3Url}/${s3Bucket}/${key}`;

/**
 * Raw GET of an object, into memory. THROWS on a missing key or any S3 fault —
 * that distinction is the whole reason this exists alongside `getObjectBytes`,
 * which flattens both into `null`.
 */
export const getObject = async (key: string): Promise<Uint8Array> =>
  s3.file(key).bytes();

/**
 * Read a full object into memory as a `Uint8Array`. Returns `null`
 * on any error (missing object, transient network failure); callers
 * that need to distinguish the two should call `getObject` and catch
 * instead. Suitable for small-to-medium payloads that fit
 * comfortably in RAM (chatbot session files are capped at 15 MB).
 */
export const getObjectBytes = async (
  key: string,
): Promise<Uint8Array | null> => {
  try {
    return await getObject(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/NoSuchKey|NotFound|does not exist|404/i.test(message)) {
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
  const response = await signer.fetch(objectUrl(args.destinationKey), {
    method: "PUT",
    headers: {
      "x-amz-copy-source": `/${s3Bucket}/${encodeKey(args.sourceKey)}`,
      ...(args.contentType ? { "content-type": args.contentType } : {}),
      ...(args.metadata
        ? {
            "x-amz-metadata-directive": "REPLACE",
            ...metadataHeaders(args.metadata),
          }
        : {}),
    },
  });
  await assertOk(response, `copyObject ${args.sourceKey}`);

  // CopyObject is the one S3 call that can fail INSIDE a 200: the connection
  // is held open while the copy runs, so a mid-copy error arrives as an
  // <Error> document under a success status. Treating 200 as done would
  // silently lose the object.
  const body = await response.text();
  if (body.includes("<Error>")) {
    throw new Error(
      `[s3] copyObject ${args.sourceKey} failed mid-copy: ${body}`,
    );
  }
};

export interface S3ObjectEntry {
  key: string;
  size: number;
  lastModified: Date | null;
}

/**
 * List every object under a prefix WITH its size and mtime. Handles paginated
 * continuation via `nextContinuationToken`. Returns `[]` on error so callers
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
      // Sequential by design: `nextContinuationToken` is only known
      // after the previous response, so the loop iterations can't be
      // parallelised.
      // eslint-disable-next-line no-await-in-loop
      const response = await s3.list({ prefix, continuationToken });
      for (const entry of response.contents ?? []) {
        entries.push({
          key: entry.key,
          size: entry.size ?? 0,
          lastModified: entry.lastModified
            ? new Date(entry.lastModified)
            : null,
        });
      }
      continuationToken = response.isTruncated
        ? response.nextContinuationToken
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
    await s3.delete(key);
  } catch (err) {
    console.warn(
      `[s3] deleteObject failed for ${key}:`,
      err instanceof Error ? err.message : err,
    );
  }
};

/** Minimal XML text escape for keys inside the DeleteObjects document. */
const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Bulk delete for a batch of keys. S3 limits a `DeleteObjects`
 * request to 1000 keys; callers that might exceed that are expected
 * to batch. No waiters — this runs in hot cleanup paths where we
 * accept eventual consistency.
 *
 * Hand-signed because Bun's client only deletes one key at a time, and a
 * folder teardown would otherwise be one request per object instead of one
 * per thousand. `Content-MD5` is not optional here: S3 rejects a
 * `POST ?delete` without it, and aws4fetch signs but does not compute it.
 */
export const deleteObjects = async (keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  try {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys
      .map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
      .join("")}<Quiet>true</Quiet></Delete>`;
    const body = new TextEncoder().encode(xml);
    const contentMd5 = new Bun.CryptoHasher("md5")
      .update(body)
      .digest("base64");

    const response = await signer.fetch(`${endpoint}/${s3Bucket}?delete=`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/xml",
        "content-md5": contentMd5,
      },
    });
    await assertOk(response, `deleteObjects (${keys.length.toString()} keys)`);
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
): Promise<string> =>
  s3.presign(key, {
    method: "GET",
    expiresIn,
    ...(options.downloadFilename !== undefined
      ? {
          contentDisposition: contentDispositionFor(options.downloadFilename),
        }
      : {}),
  });

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
 * Delete a list of document keys from the documents pipeline.
 *
 * No propagation wait: S3 DELETE has been strongly consistent since December
 * 2020 (Scaleway's implementation included), so the object is gone the moment
 * the call returns. The previous `waitUntilObjectNotExists` fan-out — one
 * polling loop per key — was paying for a guarantee the protocol already
 * gives, and it left with the AWS SDK.
 */
export const deleteFilesFromS3 = async (keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  await deleteObjects(keys);
};
