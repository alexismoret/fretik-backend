import { describe, expect, test } from "bun:test";
import { touchesIndexedFields } from "../../src/services/documents/vectorisable";

/**
 * Which document updates re-vectorise. A re-vectorisation is a chunking pass,
 * an LLM enrichment call per chunk and a round of embeddings, so the rule is
 * worth pinning both ways: a pure move must not pay for it (the vectors carry
 * no folder), and anything the vectors DO carry must still trigger it.
 */
describe("touchesIndexedFields", () => {
  test("a pure move touches nothing indexed", () => {
    expect(touchesIndexedFields({ folderId: crypto.randomUUID() })).toBe(false);
    expect(touchesIndexedFields({ folderId: null })).toBe(false);
  });

  test.each([
    { originalFilename: "Report Q3" },
    { documentSummary: "A summary." },
    { documentLanguage: "fr" },
    { documentLanguage: null },
    { fieldValues: { amount: "1500" } },
  ])("%o is indexed", (updates) => {
    expect(touchesIndexedFields(updates)).toBe(true);
  });

  test("a move plus a rename still refreshes", () => {
    expect(
      touchesIndexedFields({ folderId: null, originalFilename: "Renamed" }),
    ).toBe(true);
  });
});
