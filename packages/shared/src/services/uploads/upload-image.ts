import { fileTypeFromBuffer } from "file-type";

import {
  fileTooLarge,
  throwHttpError,
  unsupportedMediaType,
} from "../../lib/errors";
import { deleteObjects, listObjects, publicUrl, putObject } from "../../lib/s3";

type ImagePrefix = "avatars" | "org-logos";

/** Browser-facing images (avatars, org logos) — small and validated by magic bytes. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Accepted *input* formats (output is always WebP). */
const INPUT_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Longest edge of the stored WebP, per asset kind. */
const SIZE_BY_PREFIX: Record<ImagePrefix, number> = {
  avatars: 256,
  "org-logos": 512,
};

/**
 * Validate + store a public image (user avatar or org logo) under
 * `public/<prefix>/<id>-<hash>.webp` and return its permanent public URL.
 *
 * - Input is whitelisted by magic bytes (`file-type`) to PNG / JPEG / WEBP —
 *   the declared MIME is ignored, so a renamed file can't smuggle a format.
 * - Every image is normalised through Bun's native pipeline: downscaled to a
 *   small square-fit and re-encoded to WebP (off the JS thread). This shrinks
 *   payloads, strips EXIF, and gives a single predictable extension.
 * - The processed content hash busts caches; older objects for the same id
 *   are pruned so a user keeps at most one stored image.
 */
export const uploadImage = async (params: {
  prefix: ImagePrefix;
  id: string;
  file: File;
}): Promise<string> => {
  const { prefix, id, file } = params;

  if (file.size > MAX_IMAGE_BYTES) {
    return throwHttpError(
      413,
      fileTooLarge(file.name, file.size, MAX_IMAGE_BYTES),
    );
  }

  const input = new Uint8Array(await file.arrayBuffer());
  const detected = await fileTypeFromBuffer(input);
  if (!detected || !INPUT_MIMES.has(detected.mime)) {
    return throwHttpError(
      415,
      unsupportedMediaType(detected?.mime ?? file.type),
    );
  }

  const size = SIZE_BY_PREFIX[prefix];
  const processed = await new Bun.Image(input, { maxPixels: 8192 * 8192 })
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .bytes();

  const hash = Bun.hash(processed).toString(16).slice(0, 12);
  const key = `public/${prefix}/${id}-${hash}.webp`;

  await putObject({
    key,
    body: processed,
    contentType: "image/webp",
    acl: "public-read",
  });

  // Prune any previous image for this id (different hash).
  const stale = (await listObjects(`public/${prefix}/${id}-`)).filter(
    (k) => k !== key,
  );
  if (stale.length > 0) await deleteObjects(stale);

  return publicUrl(key);
};

/** Remove every stored image for an id (used when clearing an avatar/logo). */
export const deleteImages = async (
  prefix: ImagePrefix,
  id: string,
): Promise<void> => {
  const keys = await listObjects(`public/${prefix}/${id}-`);
  if (keys.length > 0) await deleteObjects(keys);
};
