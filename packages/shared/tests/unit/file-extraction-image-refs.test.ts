import { describe, expect, test } from "bun:test";
import {
  EXTRACTED_IMAGE_ID_RE,
  parseExtractedImagePath,
  rewriteExtractedImageRefs,
} from "../../src/services/file-extraction/image-refs";

/**
 * Contract of the virtual extracted-figure paths: `read` rewrites ONLY
 * refs whose id is in the stored manifest (legacy sidecars stay
 * byte-identical), and the resolver in `vision`/`read` accepts strictly
 * `attachments/<file>/<img-N.ext>` — nothing else.
 */

describe("rewriteExtractedImageRefs", () => {
  const virtualDir = "attachments/report.pdf";

  test("rewrites refs whose id is in the manifest", () => {
    const markdown = "Intro\n\n![chart](img-0.jpeg)\n\nOutro";
    expect(
      rewriteExtractedImageRefs({
        markdown,
        virtualDir,
        imageIds: ["img-0.jpeg"],
      }),
    ).toBe("Intro\n\n![chart](attachments/report.pdf/img-0.jpeg)\n\nOutro");
  });

  test("leaves refs NOT in the manifest untouched (legacy rows)", () => {
    const markdown = "![a](img-0.jpeg) and ![b](img-1.png)";
    expect(
      rewriteExtractedImageRefs({
        markdown,
        virtualDir,
        imageIds: ["img-1.png"],
      }),
    ).toBe("![a](img-0.jpeg) and ![b](attachments/report.pdf/img-1.png)");
  });

  test("empty manifest returns the markdown unchanged (same reference)", () => {
    const markdown = "![a](img-0.jpeg)";
    expect(
      rewriteExtractedImageRefs({ markdown, virtualDir, imageIds: [] }),
    ).toBe(markdown);
  });

  test("non-image markdown links and external URLs are untouched", () => {
    const markdown =
      "[link](img-0.jpeg) ![ext](https://x.test/img.png) ![rel](./img-0.jpeg)";
    expect(
      rewriteExtractedImageRefs({
        markdown,
        virtualDir,
        imageIds: ["img-0.jpeg"],
      }),
    ).toBe(markdown);
  });

  test("preserves alt text and handles multiple refs to the same id", () => {
    const markdown = "![Figure 1](img-2.webp)\n![Figure 1 again](img-2.webp)";
    expect(
      rewriteExtractedImageRefs({
        markdown,
        virtualDir,
        imageIds: ["img-2.webp"],
      }),
    ).toBe(
      "![Figure 1](attachments/report.pdf/img-2.webp)\n![Figure 1 again](attachments/report.pdf/img-2.webp)",
    );
  });
});

describe("parseExtractedImagePath", () => {
  test("accepts <dir>/<file>/<img-N.ext>", () => {
    expect(
      parseExtractedImagePath("attachments/report.pdf/img-3.jpeg"),
    ).toEqual({
      dir: "attachments",
      filename: "report.pdf",
      imageId: "img-3.jpeg",
    });
    expect(parseExtractedImagePath("attachments/a b.docx/img-0.png")).toEqual({
      dir: "attachments",
      filename: "a b.docx",
      imageId: "img-0.png",
    });
  });

  test("accepts a figure of a document the user never attached", () => {
    // The directory carries PROVENANCE, not readability: a PDF fetched
    // from SharePoint yields the same figures as the same PDF uploaded,
    // and `vision` resolves both from one content-addressed cache. This
    // used to return null, which left `read` printing figure refs that
    // pointed at nothing.
    expect(
      parseExtractedImagePath("downloads/9f2c1a04_contract.pdf/img-0.jpeg"),
    ).toEqual({
      dir: "downloads",
      filename: "9f2c1a04_contract.pdf",
      imageId: "img-0.jpeg",
    });
    expect(parseExtractedImagePath("outputs/report.pdf/img-1.png")).toEqual({
      dir: "outputs",
      filename: "report.pdf",
      imageId: "img-1.png",
    });
  });

  test("rejects everything else — the SHAPE is still strict", () => {
    // Plain attachment file (2 segments).
    expect(parseExtractedImagePath("attachments/report.pdf")).toBeNull();
    // 4 segments.
    expect(parseExtractedImagePath("attachments/a/b/img-0.jpeg")).toBeNull();
    // Non-Mistral-shaped image id — what keeps a real 3-segment file
    // (`skills/pptx/SKILL.md`, `outputs/results/call-0.png`) from being
    // mistaken for a virtual figure now that any directory is allowed.
    expect(parseExtractedImagePath("skills/pptx/SKILL.md")).toBeNull();
    expect(
      parseExtractedImagePath("outputs/results/01a0ab34-0.png"),
    ).toBeNull();
    expect(
      parseExtractedImagePath("attachments/report.pdf/photo.jpeg"),
    ).toBeNull();
    expect(
      parseExtractedImagePath("attachments/report.pdf/img-x.jpeg"),
    ).toBeNull();
    expect(
      parseExtractedImagePath("attachments/report.pdf/img-0.pdf"),
    ).toBeNull();
  });
});

describe("EXTRACTED_IMAGE_ID_RE", () => {
  test("matches Mistral-emitted ids, rejects key-unsafe strings", () => {
    for (const ok of [
      "img-0.jpeg",
      "img-12.jpg",
      "IMG-3.PNG",
      "img-4.webp",
      "img-5.gif",
    ]) {
      expect(EXTRACTED_IMAGE_ID_RE.test(ok)).toBe(true);
    }
    for (const bad of [
      "img-0",
      "img.jpeg",
      "img-0.svg",
      "../x.png",
      "img-0.jpeg/../y",
    ]) {
      expect(EXTRACTED_IMAGE_ID_RE.test(bad)).toBe(false);
    }
  });
});
