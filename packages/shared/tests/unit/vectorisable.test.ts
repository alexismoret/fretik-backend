import { describe, expect, test } from "bun:test";
import { vectorisationSkipReason } from "../../src/services/documents/vectorisable";

/**
 * The one rule that keeps a document out of the retrieval index.
 *
 * It is narrow on purpose, and these tests pin the narrowness rather than the
 * skipping: almost everything gets indexed, and a guard that quietly widened
 * would cost the corpus documents nobody would notice were missing until a
 * search came back empty.
 */

const SUMMARY =
  "A supplier invoice from Acme for consulting work carried out in March 2026, with payment terms of thirty days.";

describe("vectorisationSkipReason", () => {
  test("an ordinary document is indexed", () => {
    expect(
      vectorisationSkipReason({
        documentSummary: SUMMARY,
        confidenceScore: 0.9,
      }),
    ).toBeNull();
  });

  test("a spreadsheet of bare numbers is still indexed", () => {
    // The case that decides the whole design. Extraction describes these even
    // when it cannot read meaning into the figures, and that description is
    // exactly what makes the file findable — so a guard aimed at "unreadable"
    // must not catch "terse".
    expect(
      vectorisationSkipReason({
        documentSummary:
          "A spreadsheet of monthly figures across four columns, with no headings.",
        confidenceScore: 0.4,
      }),
    ).toBeNull();
  });

  test("a failed scan is not indexed", () => {
    expect(
      vectorisationSkipReason({ documentSummary: "", confidenceScore: 0.9 }),
    ).not.toBeNull();
  });

  test("whitespace is not a summary", () => {
    expect(
      vectorisationSkipReason({
        documentSummary: "   \n  ",
        confidenceScore: 0.9,
      }),
    ).not.toBeNull();
  });

  test("a missing summary is not indexed", () => {
    expect(vectorisationSkipReason({ documentSummary: null })).not.toBeNull();
    expect(
      vectorisationSkipReason({ documentSummary: undefined }),
    ).not.toBeNull();
  });

  test("an unassessed confidence is NOT read as a low one", () => {
    // `null` means the model would not assess itself, which is the registry's
    // own rule everywhere else: a missing signal answers "unknown" and never
    // "false". Reading it as zero would drop every document from a model that
    // does not self-score.
    expect(
      vectorisationSkipReason({
        documentSummary: SUMMARY,
        confidenceScore: null,
      }),
    ).toBeNull();
    expect(vectorisationSkipReason({ documentSummary: SUMMARY })).toBeNull();
  });

  test("an extraction that distrusts itself is not indexed", () => {
    expect(
      vectorisationSkipReason({
        documentSummary: SUMMARY,
        confidenceScore: 0.05,
      }),
    ).not.toBeNull();
  });

  test("the reason says which rule fired", () => {
    // It is logged, and a log line that does not say why is a line nobody can
    // act on.
    expect(
      vectorisationSkipReason({ documentSummary: "", confidenceScore: 0.9 }),
    ).toContain("summary");
    expect(
      vectorisationSkipReason({
        documentSummary: SUMMARY,
        confidenceScore: 0.01,
      }),
    ).toContain("confidence");
  });
});
