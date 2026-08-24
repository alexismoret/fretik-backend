import { describe, expect, test } from "bun:test";
import { buildDocumentOriginalKey } from "../../src/lib/document-storage";

/**
 * A rename must never change a document's file extension.
 *
 * Every S3 key a document owns is derived from `originalFilename` —
 * `buildDocumentOriginalKey` for the bytes, `buildDocumentVersionKey` for each
 * archived version. Until 2026-08-19 `updateDocument` wrote whatever name it
 * was handed, so renaming `rapport.pdf` to `Rapport Q3` repointed every lookup
 * at `documents/{id}` while the object stayed at `documents/{id}.pdf`: the
 * document became unreadable, undownloadable, and its whole history
 * unreachable. Silent, because nothing re-reads the bytes on a rename.
 *
 * The guard is not exported (it is an implementation detail of `updateDocument`),
 * so this pins the PROPERTY that made the bug possible — the key depends on the
 * extension — plus the normalisation rule itself, mirrored here.
 */

/** Mirror of the rule in `services/documents/update.ts`. */
const keepFileExtension = (current: string, next: string): string => {
  const dot = current.lastIndexOf(".");
  const extension = dot > 0 ? current.slice(dot) : "";
  if (extension === "") return next;
  return next.toLowerCase().endsWith(extension.toLowerCase())
    ? next
    : `${next}${extension}`;
};

const ID = "01a01234-5678-7000-8000-000000000000";

describe("a document's S3 key follows its extension", () => {
  test("dropping the extension moves the key — the bug's mechanism", () => {
    // Every non-PDF type is exposed. A `.md` document renamed to a bare title
    // would be looked up at `documents/{id}.pdf` while its bytes stay at
    // `documents/{id}.md`.
    expect(buildDocumentOriginalKey(ID, "rapport.docx")).not.toBe(
      buildDocumentOriginalKey(ID, "Rapport Q3"),
    );
  });

  test("PDFs escape it only by accident, via the key builder's fallback", () => {
    // `buildDocumentOriginalKey` defaults to `.pdf` when a name has no
    // extension, which masks the bug for exactly one type. Pinned so the
    // fallback is never mistaken for the guard.
    expect(buildDocumentOriginalKey(ID, "rapport.pdf")).toBe(
      buildDocumentOriginalKey(ID, "Rapport Q3"),
    );
  });

  test("keeping the extension keeps the key, whatever the name", () => {
    expect(buildDocumentOriginalKey(ID, "rapport.docx")).toBe(
      buildDocumentOriginalKey(ID, "Rapport Q3.docx"),
    );
  });
});

describe("rename normalisation", () => {
  test("appends the extension when the new name has none", () => {
    expect(keepFileExtension("rapport.pdf", "Rapport Q3")).toBe(
      "Rapport Q3.pdf",
    );
  });

  test("leaves a correct extension alone", () => {
    expect(keepFileExtension("rapport.pdf", "Rapport Q3.pdf")).toBe(
      "Rapport Q3.pdf",
    );
  });

  test("is case-insensitive about the match", () => {
    expect(keepFileExtension("rapport.PDF", "Rapport Q3.pdf")).toBe(
      "Rapport Q3.pdf",
    );
  });

  test("appends rather than converts when a different type is claimed", () => {
    // Clumsy on purpose: the bytes are still a PDF, and appending is lossless
    // where stripping would orphan the object.
    expect(keepFileExtension("rapport.pdf", "rapport.docx")).toBe(
      "rapport.docx.pdf",
    );
  });

  test("a dot inside the name is not an extension", () => {
    // `extname("v1.2 budget")` is ".2 budget" — stripping would have produced
    // "v1", losing most of the title.
    expect(keepFileExtension("budget.xlsx", "v1.2 budget")).toBe(
      "v1.2 budget.xlsx",
    );
  });

  test("a document with no extension is renamed verbatim", () => {
    expect(keepFileExtension("README", "Notes")).toBe("Notes");
  });
});
