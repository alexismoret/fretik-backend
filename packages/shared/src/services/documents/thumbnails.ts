import { Poppler } from "node-poppler";

const poppler = new Poppler();

/** Longest edge of the stored thumbnail, in px. */
const THUMBNAIL_SIZE = 400;
/** WebP encode quality (1–100). 80 mirrors the avatar/logo pipeline. */
const WEBP_QUALITY = 80;
/**
 * Decompression-bomb guard for the image path — the original upload is
 * already capped at 10 MB, and any realistic document scan stays well
 * under 67 MP (e.g. a 600-DPI A4 is ~34 MP). Same ceiling the
 * avatar/logo pipeline uses.
 */
const MAX_INPUT_PIXELS = 8192 * 8192;

/**
 * Resize + re-encode a raster to a compact WebP thumbnail using Bun's
 * native image pipeline (off the JS thread, no native add-on). Bounded to
 * a `THUMBNAIL_SIZE` square via `fit: "inside"` so aspect ratio is
 * preserved and small images are never upscaled.
 */
const toWebpThumbnail = (input: Uint8Array): Promise<Uint8Array> =>
  new Bun.Image(input, { maxPixels: MAX_INPUT_PIXELS })
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .bytes();

/**
 * Generate a WebP thumbnail from a PDF.
 *
 * Poppler renders page 1 to a low-DPI PNG, which is then compressed and
 * re-encoded to WebP via {@link toWebpThumbnail}.
 *
 * @param pdfBuffer - Raw PDF file as Uint8Array
 * @returns WebP thumbnail as Uint8Array
 */
export const generatePdfThumbnail = async (
  pdfBuffer: Uint8Array,
): Promise<Uint8Array> => {
  const result = await poppler.pdfToCairo(Buffer.from(pdfBuffer), undefined, {
    pngFile: true,
    singleFile: true,
    resolutionXYAxis: 50,
    firstPageToConvert: 1,
    lastPageToConvert: 1,
  });

  const pngBytes = new Uint8Array(Buffer.from(result, "binary"));
  return toWebpThumbnail(pngBytes);
};

/**
 * Generate a WebP thumbnail from an image (PNG, JPEG, WebP).
 *
 * @param imageBuffer - Raw image file as Uint8Array
 * @returns WebP thumbnail as Uint8Array
 */
export const generateImageThumbnail = (
  imageBuffer: Uint8Array,
): Promise<Uint8Array> => toWebpThumbnail(imageBuffer);
