import { extractionFor } from "../../file-types";
import type { ExtractionRoute } from "./types";

/**
 * MIME → extraction-route dispatcher. The MIME passed here is the REAL
 * type already resolved from the bytes at the upload boundary
 * (`resolveFileType`), so routing trusts it directly — no extension
 * guessing. The strategy itself is declared once per type in the
 * file-type registry; this only maps it onto the route union and names
 * the one case the registry has no word for (`unsupported`).
 *
 * The `filename` is optional and only refines textual types whose MIME
 * under-describes them (`text/plain` → source code), which changes
 * nothing about the route — both land on `text`.
 */
export const routeForMime = (
  mimeType: string,
  filename?: string,
): ExtractionRoute => {
  const strategy = extractionFor(mimeType, filename);
  return strategy === "none" ? "unsupported" : strategy;
};

/**
 * Routes whose result is worth persisting in the content-addressed
 * cache. `text` is excluded — decoding UTF-8 is cheaper than a cache
 * lookup — but every route that calls out to OCR, Gotenberg or a mail
 * parser earns its row.
 */
export const isCacheableRoute = (route: ExtractionRoute): boolean =>
  route === "mistral-ocr" ||
  route === "convert-ocr" ||
  route === "image-ocr" ||
  route === "spreadsheet" ||
  route === "email" ||
  route === "html" ||
  route === "legacy-import";
