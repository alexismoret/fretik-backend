import { describe, expect, test } from "bun:test";
import {
  acceptAttrFor,
  agentAccessFor,
  canonicalExtensionFor,
  codeLanguageFor,
  EXT_TO_MIME,
  extensionOf,
  extensionsForSurface,
  extractionFor,
  FILE_TYPES,
  iconFor,
  isChatbotSupported,
  isDriveSupported,
  isImageMime,
  isMarkdownMime,
  isOcrDocumentMime,
  isSpreadsheetMime,
  isTextMime,
  mimesForSurface,
  resolveTypeForFile,
  shouldWriteSidecar,
  thumbnailFor,
  typeForMime,
  viewerFor,
} from "../../src/file-types";
import { resolveFileType } from "../../src/file-types/detect";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Minimal buffers carrying a real magic signature. */
const PDF_BYTES = encode("%PDF-1.4\n%âãÏÓ\n1 0 obj\n");
const GIF_BYTES = new Uint8Array([
  ...encode("GIF89a"),
  0x01,
  0x00,
  0x01,
  0x00,
  0x80,
  0x00,
  0x00,
]);
/** Microsoft Compound File Binary header — .doc / .xls / .ppt / .msg share it. */
const CFB_BYTES = new Uint8Array(512);
CFB_BYTES.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);

describe("registry invariants", () => {
  test("ids are unique", () => {
    const ids = FILE_TYPES.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an extension belongs to exactly one type", () => {
    const seen = new Map<string, string>();
    for (const def of FILE_TYPES) {
      for (const ext of def.extensions) {
        const owner = seen.get(ext);
        expect(owner ?? def.id).toBe(def.id);
        seen.set(ext, def.id);
      }
    }
  });

  test("a MIME is owned by exactly one type, aliases included", () => {
    const seen = new Map<string, string>();
    for (const def of FILE_TYPES) {
      if (def.extensionOnly) continue;
      for (const mime of [def.mime, ...def.aliasMimes]) {
        const owner = seen.get(mime);
        expect(owner ?? def.id).toBe(def.id);
        seen.set(mime, def.id);
      }
    }
  });

  test("every type declares at least one extension and a Phosphor icon", () => {
    for (const def of FILE_TYPES) {
      expect(def.extensions.length).toBeGreaterThan(0);
      expect(def.icon.startsWith("i-ph-")).toBe(true);
    }
  });

  test("MIMEs fit the documents.mime_type column (varchar 100)", () => {
    for (const def of FILE_TYPES) expect(def.mime.length).toBeLessThan(100);
  });

  test("only text/plain is shared, and only by extensionOnly types", () => {
    for (const def of FILE_TYPES) {
      if (def.extensionOnly) expect(def.mime).toBe("text/plain");
    }
  });
});

describe("lookups", () => {
  test("MIME parameters and case are stripped", () => {
    expect(typeForMime("Text/CSV;charset=utf-8")?.id).toBe("csv");
  });

  test("alias MIMEs resolve to the canonical type", () => {
    expect(typeForMime("image/jpg")?.mime).toBe("image/jpeg");
    expect(typeForMime("text/xml")?.mime).toBe("application/xml");
    expect(typeForMime("application/x-yaml")?.mime).toBe("application/yaml");
  });

  test("extensionOf handles paths, case and dotless names", () => {
    expect(extensionOf("drive/Report.PDF")).toBe(".pdf");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });

  test("EXT_TO_MIME covers every registered extension", () => {
    for (const def of FILE_TYPES) {
      for (const ext of def.extensions) expect(EXT_TO_MIME[ext]).toBeDefined();
    }
    expect(EXT_TO_MIME[".pdf"]).toBe("application/pdf");
    expect(EXT_TO_MIME[".py"]).toBe("text/plain");
  });

  test("canonicalExtensionFor replaces the hardcoded .pdf fallbacks", () => {
    expect(canonicalExtensionFor("application/pdf")).toBe(".pdf");
    expect(canonicalExtensionFor("text/markdown")).toBe(".md");
    expect(canonicalExtensionFor("application/octet-stream")).toBeUndefined();
  });
});

describe("resolveTypeForFile", () => {
  test("text/plain is refined by extension into code / config", () => {
    expect(
      resolveTypeForFile({ mime: "text/plain", filename: "a.py" })?.id,
    ).toBe("code");
    expect(
      resolveTypeForFile({ mime: "text/plain", filename: "a.ini" })?.id,
    ).toBe("config");
    expect(
      resolveTypeForFile({ mime: "text/plain", filename: "notes.txt" })?.id,
    ).toBe("txt");
  });

  test("extensionless source files are recognised by basename", () => {
    expect(
      resolveTypeForFile({ mime: "text/plain", filename: "Dockerfile" })?.id,
    ).toBe("code");
  });

  test("a binary MIME always beats a lying extension", () => {
    expect(
      resolveTypeForFile({ mime: "application/pdf", filename: "a.txt" })?.id,
    ).toBe("pdf");
  });

  test("a text file misnamed .pdf stays text", () => {
    expect(
      resolveTypeForFile({ mime: "text/plain", filename: "report.pdf" })?.id,
    ).toBe("txt");
  });
});

describe("surfaces", () => {
  test("the Drive accepts documents, code, config, html and mail", () => {
    for (const mime of [
      "application/pdf",
      "text/html",
      "message/rfc822",
      "application/vnd.ms-outlook",
      "application/vnd.oasis.opendocument.text",
      "application/yaml",
      "image/gif",
      "image/svg+xml",
    ]) {
      expect(isDriveSupported(mime)).toBe(true);
    }
    expect(isDriveSupported("text/plain", "main.rs")).toBe(true);
  });

  test("video is a chat/workflow input only — never a Drive document", () => {
    expect(isChatbotSupported("video/mp4")).toBe(true);
    expect(isDriveSupported("video/mp4")).toBe(false);
  });

  test("avatars stay restricted to the three raster photo formats", () => {
    expect(mimesForSurface("avatar").sort()).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(isDriveSupported("image/gif")).toBe(true);
    expect(extensionsForSurface("avatar")).not.toContain(".gif");
  });

  test("the accept attribute lists MIMEs AND extensions", () => {
    // Browsers report an empty file.type for most source files, so the
    // extensions have to be in the accept attribute too.
    const accept = acceptAttrFor("drive");
    expect(accept).toContain("application/pdf");
    expect(accept).toContain(".py");
    expect(accept).toContain(".eml");
  });

  test("an unknown but UTF-8 text type is accepted everywhere but avatars", () => {
    expect(isChatbotSupported("text/x-lisp")).toBe(true);
    expect(isDriveSupported("text/x-lisp")).toBe(true);
  });
});

describe("category predicates", () => {
  test("parity with the pre-registry behaviour", () => {
    expect(isOcrDocumentMime("application/pdf")).toBe(true);
    expect(isOcrDocumentMime("image/png")).toBe(false);
    expect(isSpreadsheetMime("text/csv;charset=utf-8")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("text/x-python")).toBe(true); // legacy vendor MIME
    expect(isImageMime("image/png")).toBe(true);
    expect(isMarkdownMime("text/markdown")).toBe(true);
  });

  test("OpenDocument is NOT native-OCR — it converts first", () => {
    expect(isOcrDocumentMime("application/vnd.oasis.opendocument.text")).toBe(
      false,
    );
    expect(extractionFor("application/vnd.oasis.opendocument.text")).toBe(
      "convert-ocr",
    );
  });

  test("SVG is markup, not a raster to OCR", () => {
    expect(extractionFor("image/svg+xml")).toBe("text");
    expect(isImageMime("image/svg+xml")).toBe(true);
  });
});

describe("strategies", () => {
  test("html keeps a markdown sidecar but stays raw for the agent", () => {
    expect(extractionFor("text/html")).toBe("html");
    expect(agentAccessFor("text/html")).toBe("raw-text");
    expect(viewerFor("text/html")).toBe("html-iframe");
    expect(thumbnailFor("text/html")).toBe("chromium-screenshot");
  });

  test("markdown finally gets a thumbnail", () => {
    expect(thumbnailFor("text/markdown")).toBe("chromium-screenshot");
  });

  test("mail is read through its sidecar", () => {
    expect(extractionFor("message/rfc822")).toBe("email");
    expect(agentAccessFor("application/vnd.ms-outlook")).toBe("email-sidecar");
  });

  test("a CSV is read verbatim while an XLSX goes to python", () => {
    expect(agentAccessFor("text/csv")).toBe("raw-text");
    expect(agentAccessFor("application/vnd.ms-excel")).toBe("tabular");
  });

  test("code files get a code viewer and a language", () => {
    expect(viewerFor("text/plain", "main.go")).toBe("code");
    expect(codeLanguageFor("main.go")).toBe("go");
    expect(codeLanguageFor("Dockerfile")).toBe("dockerfile");
    expect(codeLanguageFor("mystery.zzz")).toBeUndefined();
  });

  test("icons come from one Phosphor map", () => {
    expect(iconFor("application/pdf")).toBe("i-ph-file-pdf");
    expect(iconFor("text/plain", "main.rs")).toBe("i-ph-file-code");
    expect(iconFor("application/octet-stream")).toBe("i-ph-file");
  });

  test("sidecar policy: always for docs, never for text, conditional for images", () => {
    expect(shouldWriteSidecar("application/pdf", "")).toBe(true);
    expect(shouldWriteSidecar("text/plain", "whatever")).toBe(false);
    expect(shouldWriteSidecar("image/png", "  \n ")).toBe(false);
    expect(shouldWriteSidecar("image/png", "a".repeat(25))).toBe(true);
  });
});

describe("resolveFileType", () => {
  test("magic bytes beat a lying declared MIME", async () => {
    const resolved = await resolveFileType({
      bytes: PDF_BYTES,
      declaredMime: "text/plain",
      filename: "notes.txt",
    });
    expect(resolved.mimeType).toBe("application/pdf");
    expect(resolved.type?.id).toBe("pdf");
  });

  test("a text file misnamed .pdf is stored as text", async () => {
    const resolved = await resolveFileType({
      bytes: encode("just plain notes, not a pdf\n"),
      declaredMime: "application/pdf",
      filename: "report.pdf",
    });
    expect(resolved.mimeType).toBe("text/plain");
    expect(resolved.type?.id).toBe("txt");
  });

  test("textual formats are resolved from the extension", async () => {
    const md = await resolveFileType({
      bytes: encode("# Title\n"),
      declaredMime: "text/plain",
      filename: "readme.md",
    });
    expect(md.mimeType).toBe("text/markdown");

    const html = await resolveFileType({
      bytes: encode("<!doctype html><p>hi</p>"),
      filename: "page.html",
    });
    expect(html.mimeType).toBe("text/html");

    const eml = await resolveFileType({
      bytes: encode("From: a@b.c\nSubject: hi\n\nbody\n"),
      filename: "mail.eml",
    });
    expect(eml.mimeType).toBe("message/rfc822");
  });

  test("source code is stored as text/plain but typed as code", async () => {
    const resolved = await resolveFileType({
      bytes: encode("def f():\n    return 1\n"),
      declaredMime: "text/x-python",
      filename: "script.py",
    });
    expect(resolved.mimeType).toBe("text/plain");
    expect(resolved.type?.id).toBe("code");
    expect(resolved.type?.viewer).toBe("code");
  });

  test("CFB containers are disambiguated by extension", async () => {
    const doc = await resolveFileType({ bytes: CFB_BYTES, filename: "a.doc" });
    expect(doc.mimeType).toBe("application/msword");

    const msg = await resolveFileType({ bytes: CFB_BYTES, filename: "a.msg" });
    expect(msg.mimeType).toBe("application/vnd.ms-outlook");
    expect(msg.type?.family).toBe("email");

    // A .msg renamed .docx must NOT be taken for a Word document.
    const renamed = await resolveFileType({
      bytes: CFB_BYTES,
      filename: "a.docx",
    });
    expect(renamed.type).toBeNull();
  });

  test("gif is detected from its magic bytes", async () => {
    const resolved = await resolveFileType({
      bytes: GIF_BYTES,
      filename: "a.gif",
    });
    expect(resolved.mimeType).toBe("image/gif");
  });

  test("an unknown binary yields no type", async () => {
    const resolved = await resolveFileType({
      bytes: new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]),
      declaredMime: "application/pdf",
      filename: "x.pdf",
    });
    expect(resolved.mimeType).toBe("application/octet-stream");
    expect(resolved.type).toBeNull();
  });
});
