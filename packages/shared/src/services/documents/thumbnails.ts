import { Poppler } from "node-poppler";
import sharp from "sharp";

const poppler = new Poppler();

const THUMBNAIL_WIDTH = 400;

/**
 * Generate thumbnail from PDF Buffer
 *
 * @param pdfBuffer - Raw PDF file as Uint8Array
 * @returns PNG thumbnail as Uint8Array
 */
export const generatePdfThumbnail = async (
  pdfBuffer: Uint8Array,
): Promise<Uint8Array> => {
  const pdfBufferNode = Buffer.from(pdfBuffer);

  const result = await poppler.pdfToCairo(pdfBufferNode, undefined, {
    pngFile: true,
    singleFile: true,
    resolutionXYAxis: 50,
    firstPageToConvert: 1,
    lastPageToConvert: 1,
  });

  return new Uint8Array(Buffer.from(result, "binary"));
};

/**
 * Generate thumbnail from image Buffer (PNG, JPEG, WebP)
 *
 * @param imageBuffer - Raw image file as Uint8Array
 * @returns PNG thumbnail as Uint8Array
 */
export const generateImageThumbnail = async (
  imageBuffer: Uint8Array,
): Promise<Uint8Array> => {
  const result = await sharp(imageBuffer)
    .resize(THUMBNAIL_WIDTH, undefined, { withoutEnlargement: true })
    .png()
    .toBuffer();

  return new Uint8Array(result);
};
