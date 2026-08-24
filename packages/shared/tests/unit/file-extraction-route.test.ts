import { describe, expect, test } from "bun:test";
import {
  isCacheableRoute,
  routeForMime,
} from "../../src/services/file-extraction/route";

/**
 * No-regression contract for the file-extraction routing core. The
 * category facts themselves live in the file-type registry and are
 * covered by `file-types.test.ts`; what matters here is the mapping onto
 * the route union and which routes are worth caching.
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

  test("OpenDocument / RTF convert to PDF before OCR", () => {
    for (const mime of [
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/rtf",
    ]) {
      expect(routeForMime(mime)).toBe("convert-ocr");
    }
  });

  test("images → image-ocr", () => {
    expect(routeForMime("image/png")).toBe("image-ocr");
    expect(routeForMime("image/jpeg")).toBe("image-ocr");
    expect(routeForMime("image/webp")).toBe("image-ocr");
    expect(routeForMime("image/gif")).toBe("image-ocr");
  });

  test("spreadsheets → spreadsheet", () => {
    expect(routeForMime("application/vnd.ms-excel")).toBe("spreadsheet");
    expect(
      routeForMime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("spreadsheet");
  });

  test("mail and HTML have routes of their own", () => {
    expect(routeForMime("message/rfc822")).toBe("email");
    expect(routeForMime("application/vnd.ms-outlook")).toBe("email");
    expect(routeForMime("text/html")).toBe("html");
  });

  test("text / code / data → text", () => {
    for (const mime of [
      "text/plain",
      "text/markdown",
      "application/json",
      "application/xml",
      "text/xml",
      "application/x-yaml",
      "image/svg+xml", // markup, not a raster
    ]) {
      expect(routeForMime(mime)).toBe("text");
    }
    // Source code is stored as text/plain and routes as text either way.
    expect(routeForMime("text/plain", "main.go")).toBe("text");
  });

  test("MIME parameters are stripped", () => {
    expect(routeForMime("text/plain;charset=utf-8")).toBe("text");
    expect(routeForMime("application/pdf; qs=0.9")).toBe("mistral-ocr");
  });

  test("genuinely unknown binary → unsupported", () => {
    expect(routeForMime("application/octet-stream")).toBe("unsupported");
  });

  test("every route that calls out to a service is cacheable", () => {
    for (const route of [
      "mistral-ocr",
      "convert-ocr",
      "image-ocr",
      "spreadsheet",
      "email",
      "html",
      "legacy-import",
    ] as const) {
      expect(isCacheableRoute(route)).toBe(true);
    }
    // Decoding UTF-8 is cheaper than a cache lookup.
    expect(isCacheableRoute("text")).toBe(false);
    expect(isCacheableRoute("unsupported")).toBe(false);
  });
});
