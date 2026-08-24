import { describe, expect, test } from "bun:test";

import { withNameSuffix } from "../../src/services/documents/name-collision";
import { versionedFilename } from "../../src/services/documents/versions/download";

/**
 * Both helpers put a number into a filename, and both must put it in the same
 * place: BEFORE the extension.
 *
 * This is the class of bug the rename guard already produced once — a name
 * whose extension moved repointed every S3 read at a key holding nothing, in
 * silence. These are the cases that catch it: a plain name, a compound
 * extension, a dot inside the name, a dotfile, and a name with no extension at
 * all.
 */

describe("withNameSuffix", () => {
  test("counts before the extension", () => {
    expect(withNameSuffix("report.pdf", 2)).toBe("report (2).pdf");
    expect(withNameSuffix("report.pdf", 10)).toBe("report (10).pdf");
  });

  test("splits at the LAST dot, so a dotted name keeps its extension", () => {
    expect(withNameSuffix("v1.2 budget.xlsx", 2)).toBe("v1.2 budget (2).xlsx");
    // A compound extension is not special-cased: `.gz` is what the storage
    // layer sees, and moving the counter inside `.tar.gz` would change it.
    expect(withNameSuffix("archive.tar.gz", 2)).toBe("archive.tar (2).gz");
  });

  test("a dotfile is all name, so the counter goes at the end", () => {
    expect(withNameSuffix(".env", 2)).toBe(".env (2)");
  });

  test("a name with no extension keeps none", () => {
    expect(withNameSuffix("notes", 3)).toBe("notes (3)");
  });
});

describe("versionedFilename", () => {
  test("marks the version before the extension", () => {
    expect(versionedFilename("report.md", 3)).toBe("report (v3).md");
    expect(versionedFilename("scan.pdf", 1)).toBe("scan (v1).pdf");
  });

  test("agrees with withNameSuffix on where the split is", () => {
    expect(versionedFilename("v1.2 budget.xlsx", 4)).toBe(
      "v1.2 budget (v4).xlsx",
    );
    expect(versionedFilename(".env", 2)).toBe(".env (v2)");
    expect(versionedFilename("notes", 2)).toBe("notes (v2)");
  });
});
