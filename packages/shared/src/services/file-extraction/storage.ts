import { EXT_TO_MIME, extensionOf } from "../../file-types";
import type { OcrExtractedImage } from "../../lib/mistral-ocr";
import { getObjectBytes, putObject } from "../../lib/s3";
import { EXTRACTED_IMAGE_ID_RE } from "./image-refs";

/**
 * Content-addressed S3 layout for the shared extraction cache. Keyed by
 * `organizationId` (tenant isolation) + hex `fileHash` (the dedup key).
 * Sibling prefix to `chatbot-sessions/`, `documents/`, `ai-context/`.
 *
 *   file-extractions/{organizationId}/{fileHash}.md         → markdown sidecar
 *   file-extractions/{organizationId}/{fileHash}/{imageId}  → embedded image
 *
 * A SINGLE `.md` artifact per file — the same flattened markdown the
 * agent reads. Page boundaries (needed only by Drive's per-page
 * down-selection) are preserved inline via `flattenOcrMarkdown`'s page
 * separator and reconstructed with `splitFlattenedMarkdown` on the rare
 * cross-surface cache hit; no separate JSON. Embedded images extracted
 * by OCR are stored per-id under the hash prefix (ids listed in
 * `file_extractions.image_ids`). Both `organizationId` (uuid) and
 * `fileHash` (hex) are already key-safe; image ids are validated
 * against EXTRACTED_IMAGE_ID_RE before use in a key.
 */

const PREFIX = "file-extractions";

/** Persistence bounds for embedded images (per file). */
export const MAX_EXTRACTED_IMAGES = 12;
export const MAX_EXTRACTED_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * MIME type for a validated extracted-image id (`img-3.png`). The id is
 * produced by `image-refs.ts`, whose pattern only admits raster
 * extensions, so the registry lookup always lands on an image type.
 */
export const extractedImageContentType = (imageId: string): string =>
  EXT_TO_MIME[extensionOf(imageId)] ?? "application/octet-stream";

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

export const buildExtractionImageKey = (
  organizationId: string,
  fileHash: string,
  imageId: string,
): string => `${PREFIX}/${organizationId}/${fileHash}/${imageId}`;

/**
 * Persist the embedded images extracted by OCR. Runs only on a cache
 * MISS of the parent extraction, so images are deduped at the same
 * level as the sidecar (per org + parent file hash). Bounded (id shape,
 * per-image size, total count) and soft-failing per image — a bad or
 * oversized image is skipped with a warn, never thrown; the sidecar and
 * the extraction row must land regardless. Returns the ids actually
 * stored (the `image_ids` manifest).
 */
export const writeExtractionImages = async (
  organizationId: string,
  fileHash: string,
  images: OcrExtractedImage[],
): Promise<string[]> => {
  const storedIds: string[] = [];
  for (const image of images) {
    if (storedIds.length >= MAX_EXTRACTED_IMAGES) break;
    if (!EXTRACTED_IMAGE_ID_RE.test(image.id)) {
      console.warn(
        `writeExtractionImages: skipping unexpected image id "${image.id}"`,
      );
      continue;
    }
    try {
      const bytes = Buffer.from(image.base64, "base64");
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_EXTRACTED_IMAGE_BYTES
      ) {
        continue;
      }
      await putObject({
        key: buildExtractionImageKey(organizationId, fileHash, image.id),
        body: new Uint8Array(bytes),
        contentType: extractedImageContentType(image.id),
      });
      storedIds.push(image.id);
    } catch (error) {
      console.warn(
        `writeExtractionImages: failed to store "${image.id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return storedIds;
};

/** Read one stored embedded image. Returns `null` on miss. */
export const readExtractionImage = async (
  key: string,
): Promise<Uint8Array | null> => getObjectBytes(key);
