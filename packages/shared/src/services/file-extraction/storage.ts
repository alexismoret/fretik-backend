import { getObjectBytes, putObject } from "../../lib/s3";

/**
 * Content-addressed S3 layout for the shared extraction cache. Keyed by
 * `organizationId` (tenant isolation) + hex `fileHash` (the dedup key).
 * Sibling prefix to `chatbot-sessions/`, `documents/`, `ai-context/`.
 *
 *   file-extractions/{organizationId}/{fileHash}.md → markdown sidecar
 *
 * A SINGLE `.md` artifact per file — the same flattened markdown the
 * agent reads. Page boundaries (needed only by Drive's per-page
 * down-selection) are preserved inline via `flattenOcrMarkdown`'s page
 * separator and reconstructed with `splitFlattenedMarkdown` on the rare
 * cross-surface cache hit; no separate JSON. Both `organizationId`
 * (uuid) and `fileHash` (hex) are already key-safe.
 */

const PREFIX = "file-extractions";

export const buildExtractionSidecarKey = (
  organizationId: string,
  fileHash: string,
): string => `${PREFIX}/${organizationId}/${fileHash}.md`;

/** Write the markdown sidecar to its content-addressed key. */
export const writeExtractionSidecar = async (
  organizationId: string,
  fileHash: string,
  markdown: string,
): Promise<string> => {
  const key = buildExtractionSidecarKey(organizationId, fileHash);
  await putObject({
    key,
    body: new TextEncoder().encode(markdown),
    contentType: "text/markdown; charset=utf-8",
  });
  return key;
};

/** Read the cached markdown sidecar. Returns `null` on miss. */
export const readExtractionSidecar = async (
  sidecarS3Key: string,
): Promise<string | null> => {
  const bytes = await getObjectBytes(sidecarS3Key);
  return bytes ? new TextDecoder().decode(bytes) : null;
};
