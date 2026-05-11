import { Chromiumly, LibreOffice } from "chromiumly";

Chromiumly.configure({
  endpoint: process.env.GOTENBERG_ENDPOINT!,
  username: process.env.GOTENBERG_API_BASIC_AUTH_USERNAME,
  password: process.env.GOTENBERG_API_BASIC_AUTH_PASSWORD,
});

type LibreOfficeFileExtension = Extract<
  Parameters<typeof LibreOffice.convert>[0]["files"][number],
  { ext: string }
>["ext"];

/**
 * Converts the first page of a document to PDF using Gotenberg.
 * The result is ephemeral (not saved to S3) — used for thumbnail
 * generation and as pre-extraction input for Excel/CSV files (spreadsheets
 * are often multi-sheet monsters whose extra sheets don't help with
 * classification).
 */
export const convertFirstPageToPdf = async (
  buffer: Uint8Array,
  extension: string,
): Promise<Uint8Array> => {
  const ext = extension.replace(
    /^\./,
    "",
  ) as unknown as LibreOfficeFileExtension;

  const result = await LibreOffice.convert({
    files: [{ data: Buffer.from(buffer), ext }],
    properties: { nativePageRanges: { from: 1, to: 1 } },
  });

  return new Uint8Array(result);
};

/**
 * Converts an entire document to PDF using Gotenberg (no page range limit).
 * Used as pre-extraction input for Word/PowerPoint files — Mistral OCR
 * expects a PDF or image, and we want the LLM to see all pages, not
 * just page 1.
 */
export const convertDocumentToPdf = async (
  buffer: Uint8Array,
  extension: string,
): Promise<Uint8Array> => {
  const ext = extension.replace(
    /^\./,
    "",
  ) as unknown as LibreOfficeFileExtension;

  const result = await LibreOffice.convert({
    files: [{ data: Buffer.from(buffer), ext }],
  });

  return new Uint8Array(result);
};
