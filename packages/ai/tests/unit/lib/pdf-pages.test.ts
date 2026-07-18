import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import {
  formatPageRanges,
  getPdfPageCount,
  parsePageSelection,
  slicePdfPages,
} from "../../../src/lib/pdf-pages";

/** Build a tiny in-memory PDF with `pages` blank pages. */
const buildPdf = async (pages: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) {
    doc.addPage([200, 200]);
  }
  return doc.save();
};

describe("parsePageSelection", () => {
  test("single page, list, and ranges parse sorted + deduped", () => {
    expect(parsePageSelection("3", 10)).toEqual([3]);
    expect(parsePageSelection("2-5", 10)).toEqual([2, 3, 4, 5]);
    expect(parsePageSelection("6,1,4-5,4", 10)).toEqual([1, 4, 5, 6]);
    expect(parsePageSelection(" 1 , 3-4 ", 10)).toEqual([1, 3, 4]);
  });

  test("rejects malformed grammar", () => {
    for (const spec of ["", "a", "1-", "-2", "1--3", "1,,2", "1;3"]) {
      expect(parsePageSelection(spec, 10)).toHaveProperty("error");
    }
  });

  test("rejects 0-based, descending, and out-of-bounds ranges", () => {
    expect(parsePageSelection("0", 10)).toHaveProperty("error");
    expect(parsePageSelection("5-3", 10)).toHaveProperty("error");
    expect(parsePageSelection("9-11", 10)).toHaveProperty("error");
    expect(parsePageSelection("11", 10)).toHaveProperty("error");
  });
});

describe("formatPageRanges", () => {
  test("compacts consecutive runs", () => {
    expect(formatPageRanges([1, 2, 3, 7])).toBe("1-3,7");
    expect(formatPageRanges([4])).toBe("4");
    expect(formatPageRanges([1, 3, 5])).toBe("1,3,5");
    expect(formatPageRanges([])).toBe("");
  });
});

describe("pdf slicing", () => {
  test("page count round-trips", async () => {
    const bytes = await buildPdf(5);
    expect(await getPdfPageCount(bytes)).toBe(5);
  });

  test("slice keeps only the selected pages", async () => {
    const bytes = await buildPdf(6);
    const sliced = await slicePdfPages(bytes, [2, 3, 6]);
    expect(sliced).not.toBeNull();
    expect(await getPdfPageCount(sliced as Uint8Array)).toBe(3);
  });

  test("corrupt bytes degrade to null instead of throwing", async () => {
    const garbage = new TextEncoder().encode("not a pdf at all");
    expect(await getPdfPageCount(garbage)).toBeNull();
    expect(await slicePdfPages(garbage, [1])).toBeNull();
  });
});
