import { describe, expect, test } from "bun:test";
import { flattenRichBlocks } from "../../../../src/services/vectorize/flatten-rich-blocks";

/**
 * What the index is allowed to see.
 *
 * Two properties matter and they pull against each other: no readable text may
 * disappear, and no marker may survive. The tests below pin both, plus the
 * one thing that must never be touched — fenced code, where `::` and `:name[]`
 * are legitimate source text.
 */

describe("flattenRichBlocks — markers out, prose intact", () => {
  test("a container block keeps every word it wrapped", () => {
    const out = flattenRichBlocks(
      [
        "::tabs",
        ':::tabs-item{label="Scheduled"}',
        "Runs on a fixed clock.",
        ":::",
        ':::tabs-item{label="On event"}',
        "Runs when a document arrives.",
        ":::",
        "::",
      ].join("\n"),
    );
    expect(out).toContain("Runs on a fixed clock.");
    expect(out).toContain("Runs when a document arrives.");
    // The labels are content too — they say what each branch is.
    expect(out).toContain("- Scheduled");
    expect(out).toContain("- On event");
    expect(out).not.toContain("tabs-item");
    expect(out).not.toContain("::");
  });

  test("attribute-only blocks survive as their values, not as config", () => {
    // The failure this exists for: a stat tile's numbers live entirely inside
    // the braces, so dropping the line would delete them from the index and
    // keeping it verbatim would index `label=` / `value=` as if they were words.
    const out = flattenRichBlocks(
      [
        "::stat-group",
        ':::stat{label="Revenue" value="1.2M" delta="+8%"}',
        ":::",
        "::",
      ].join("\n"),
    );
    expect(out.trim()).toBe("- Revenue 1.2M +8%");
  });

  test("styling attributes are dropped, unknown ones are kept", () => {
    // Deny-list, not allow-list: `caption` is invented here and must survive,
    // because a block type nobody updated this file for still has to flatten.
    const out = flattenRichBlocks(
      '::card{title="Onboarding" icon="i-lucide-check" caption="Start here"}\n::',
    );
    expect(out.trim()).toBe("- Onboarding Start here");
    expect(out).not.toContain("i-lucide");
  });

  test("inline spans become their label; decoration disappears", () => {
    const out = flattenRichBlocks(
      'Status :badge[Active] — press :kbd[Ctrl] :icon{name="i-lucide-check"}',
    );
    expect(out).toBe("Status Active — press Ctrl ");
  });
});

describe("flattenRichBlocks — what it must not touch", () => {
  test("fenced code is byte-identical, colons and all", () => {
    const source = [
      "Before.",
      "```yaml",
      "::not-a-block",
      'key: ":badge[x]"',
      "```",
      "After.",
    ].join("\n");
    expect(flattenRichBlocks(source)).toBe(source);
  });

  test("prose that merely starts with colons is left alone", () => {
    // The block rule requires the WHOLE line to be marker syntax; a sentence
    // beginning with a marker-looking token is ordinary text.
    const source = ':::tabs-item{label="x"} and then some prose\n';
    expect(flattenRichBlocks(source)).toBe(source);
  });

  test("markdown with no MDC passes through unchanged", () => {
    // Uploaded documents' OCR text and skill bodies take this path, which is
    // why the pass can run unconditionally on every source.
    const source =
      "# Report\n\nSee https://example.com at 12:30.\n\n| a | b |\n| - | - |\n";
    expect(flattenRichBlocks(source)).toBe(source);
  });

  test("dropped markers do not leave phantom paragraph breaks", () => {
    // The chunker splits on `\n\n`; runs of blank lines left by removed
    // markers would fabricate boundaries that are not in the document.
    const out = flattenRichBlocks(
      "::steps\n\n### One\n\nDo it.\n\n::\n\n### Two\n\nDone.\n",
    );
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain("### One");
    expect(out).toContain("### Two");
  });
});
