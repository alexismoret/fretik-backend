import { describe, expect, test } from "bun:test";
import {
  isCacheableRoute,
  routeForMime,
} from "../../src/services/file-extraction/route";
import {
  detectMimeFromBytes,
  isLikelyUtf8Text,
  isOcrDocumentMime,
  isSpreadsheetMime,
  isTextMime,
} from "../../src/utils/mimeTypes";

/**
 * No-regression contract for the file-extraction routing core: documents
 * and images stay on Mistral OCR (universal extractor), spreadsheets go
 * to the spreadsheet branch (chatbot routes those to python separately),
 * and ANY UTF-8 source/code file is recognised as text — never by
 * extension, always by detected MIME / content.
 */

describe("routeForMime", () => {
  test("PDF / DOCX / PPTX (and legacy doc/ppt) → mistral-ocr", () => {
    for (const mime of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword",
      "application/vnd.ms-powerpoint",
    ]) {
      expect(routeForMime(mime)).toBe("mistral-ocr");
    }
  });

  test("images → image-ocr", () => {
    expect(routeForMime("image/png")).toBe("image-ocr");
    expect(routeForMime("image/jpeg")).toBe("image-ocr");
    expect(routeForMime("image/webp")).toBe("image-ocr");
  });

  test("spreadsheets → spreadsheet", () => {
    expect(routeForMime("application/vnd.ms-excel")).toBe("spreadsheet");
    expect(
      routeForMime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("spreadsheet");
  });

  test("text / code / data → text", () => {
    for (const mime of [
      "text/plain",
      "text/markdown",
      "application/json",
      "application/xml",
      "text/xml",
      "text/javascript",
      "application/x-yaml",
    ]) {
      expect(routeForMime(mime)).toBe("text");
    }
  });

  test("MIME parameters are stripped", () => {
    expect(routeForMime("text/plain;charset=utf-8")).toBe("text");
    expect(routeForMime("application/pdf; qs=0.9")).toBe("mistral-ocr");
  });

  test("genuinely unknown binary → unsupported", () => {
    expect(routeForMime("application/octet-stream")).toBe("unsupported");
  });

  test("only OCR / image / spreadsheet routes are cacheable", () => {
    expect(isCacheableRoute("mistral-ocr")).toBe(true);
    expect(isCacheableRoute("image-ocr")).toBe(true);
    expect(isCacheableRoute("spreadsheet")).toBe(true);
    expect(isCacheableRoute("legacy-import")).toBe(true);
    expect(isCacheableRoute("text")).toBe(false);
    expect(isCacheableRoute("unsupported")).toBe(false);
  });
});

describe("canonical MIME predicates", () => {
  test("category predicates are mutually consistent", () => {
    expect(isOcrDocumentMime("application/pdf")).toBe(true);
    expect(isSpreadsheetMime("text/csv;charset=utf-8")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("text/x-python")).toBe(true);
    expect(isOcrDocumentMime("image/png")).toBe(false);
  });
});

describe("isLikelyUtf8Text", () => {
  test("plain UTF-8 text is detected", () => {
    expect(isLikelyUtf8Text(new TextEncoder().encode("const x = 1;\n"))).toBe(
      true,
    );
    expect(isLikelyUtf8Text(new TextEncoder().encode("héllo — wörld"))).toBe(
      true,
    );
  });

  test("a NUL byte marks the content as binary", () => {
    expect(isLikelyUtf8Text(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
  });

  test("empty input is treated as text", () => {
    expect(isLikelyUtf8Text(new Uint8Array(0))).toBe(true);
  });
});

describe("detectMimeFromBytes", () => {
  test("PDF magic bytes win over a wrong declared text MIME", async () => {
    // "%PDF-1.4" header — a real PDF mislabeled as text/plain.
    const pdf = new TextEncoder().encode("%PDF-1.4\n%âãÏÓ\n1 0 obj\n");
    expect(await detectMimeFromBytes(pdf, "text/plain")).toBe(
      "application/pdf",
    );
  });

  test("UTF-8 text mislabeled as application/pdf is corrected to text", async () => {
    // The exact "a .txt named .pdf" case: no binary signature → sniff.
    const bytes = new TextEncoder().encode("just plain notes, not a pdf\n");
    const mime = await detectMimeFromBytes(bytes, "application/pdf");
    expect(isTextMime(mime)).toBe(true);
  });

  test("a canonical text MIME is preserved for source/data files", async () => {
    const json = new TextEncoder().encode('{"a":1}');
    expect(await detectMimeFromBytes(json, "application/json")).toBe(
      "application/json",
    );
    const html = new TextEncoder().encode("<!doctype html><p>hi</p>");
    expect(await detectMimeFromBytes(html, "text/html")).toBe("text/html");
  });

  test("non-canonical / vendor / empty text MIMEs normalise to text/plain", async () => {
    const py = new TextEncoder().encode("def f():\n    return 1\n");
    // We only ever PERSIST registered types — vendor/legacy/empty → text/plain.
    expect(await detectMimeFromBytes(py, "text/x-python")).toBe("text/plain");
    expect(await detectMimeFromBytes(py, "application/x-yaml")).toBe(
      "text/plain",
    );
    expect(await detectMimeFromBytes(py, "")).toBe("text/plain");
    expect(await detectMimeFromBytes(py, "text/foobar")).toBe("text/plain");
    // …and the result is still routed/accepted as text.
    expect(isTextMime("text/plain")).toBe(true);
  });
});
