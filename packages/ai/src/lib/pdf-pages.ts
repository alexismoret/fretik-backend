import { PDFDocument } from "pdf-lib";

/**
 * PDF page primitives shared by the `extract` engine (chunking a large
 * document into page-range calls) and the `vision` tool (optional `pages`
 * targeting instead of sending the whole document).
 *
 * All page numbers are 1-based — the grammar the agent writes ("2-9",
 * "1,4-6") and the numbers printed on the document. Conversion to
 * pdf-lib's 0-based indices happens inside `slicePdfPages` only.
 *
 * Encrypted or corrupt PDFs make `PDFDocument.load` throw — the helpers
 * return `null` instead so callers can degrade (send the whole document
 * unsliced) rather than fail the tool call.
 */

/** Max individual pages a single selection may expand to (sanity bound). */
const MAX_SELECTED_PAGES = 1_000;

const PAGE_SELECTION_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

export interface PageSelectionError {
  error: string;
}

/**
 * Parse a 1-based page-selection string ("2-9", "1,4-6") into a sorted,
 * deduplicated page list, bounds-checked against `totalPages`.
 */
export const parsePageSelection = (
  spec: string,
  totalPages: number,
): number[] | PageSelectionError => {
  const trimmed = spec.replaceAll(" ", "");
  if (!PAGE_SELECTION_RE.test(trimmed)) {
    return {
      error: `Invalid page selection "${spec}" — expected 1-based pages like "3", "2-9" or "1,4-6".`,
    };
  }
  const selected = new Set<number>();
  for (const part of trimmed.split(",")) {
    const [startRaw, endRaw] = part.split("-");
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    if (start < 1 || end < start) {
      return {
        error: `Invalid page range "${part}" — pages are 1-based and ranges must be ascending.`,
      };
    }
    if (end > totalPages) {
      return {
        error: `Page range "${part}" exceeds the document (${totalPages} page${totalPages === 1 ? "" : "s"}).`,
      };
    }
    for (let page = start; page <= end; page++) {
      selected.add(page);
      if (selected.size > MAX_SELECTED_PAGES) {
        return {
          error: `Page selection expands to more than ${MAX_SELECTED_PAGES} pages — narrow the range.`,
        };
      }
    }
  }
  return [...selected].sort((a, b) => a - b);
};

/** Compact range string for a sorted page list: [1,2,3,7] → "1-3,7". */
export const formatPageRanges = (pages: readonly number[]): string => {
  const ranges: string[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const page of pages) {
    if (start === null) {
      start = page;
    } else if (page !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = page;
    }
    prev = page;
  }
  if (start !== null) {
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  }
  return ranges.join(",");
};

/** Page count, or `null` when the PDF cannot be parsed (encrypted/corrupt). */
export const getPdfPageCount = async (
  bytes: Uint8Array,
): Promise<number | null> => {
  try {
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount();
  } catch {
    return null;
  }
};

/**
 * Build a new PDF containing only the given 1-based pages, in the given
 * order. Returns `null` when the source cannot be parsed or re-assembled
 * (encrypted/corrupt) — the caller degrades to the unsliced document.
 */
export const slicePdfPages = async (
  bytes: Uint8Array,
  pages: readonly number[],
): Promise<Uint8Array | null> => {
  try {
    const source = await PDFDocument.load(bytes);
    const target = await PDFDocument.create();
    const copied = await target.copyPages(
      source,
      pages.map((page) => page - 1),
    );
    for (const page of copied) {
      target.addPage(page);
    }
    return await target.save();
  } catch {
    return null;
  }
};
