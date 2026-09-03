import { describe, expect, test } from "bun:test";
import { diffLines } from "../../src/lib/line-diff";

/**
 * The number the page builder is measured on.
 *
 * "A fix touching 7% of the lines re-emitted 100% of the file" was computed by
 * hand from two conversations. It becomes a metric only if the denominator is
 * right, so the cases here are the ones that would quietly inflate it: a change
 * that SHIFTS lines without changing them, and a modification counted twice.
 */

describe("diffLines", () => {
  test("identical files are no change at all", () => {
    const text = "a\nb\nc";
    expect(diffLines(text, text)).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      approximate: false,
    });
  });

  test("one modified line is ONE change, not an add plus a remove", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    expect(diffLines(before, after).changed).toBe(1);
  });

  test("inserting a line above does not make the lines below changed", () => {
    // The case that inflates every naive diff: an insert shifts everything
    // after it, and a positional comparison calls the whole file rewritten.
    const before = "a\nb\nc\nd";
    const after = "new\na\nb\nc\nd";
    const diff = diffLines(before, after);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.changed).toBe(1);
  });

  test("a whole-file rewrite reads as a whole-file rewrite", () => {
    const before = Array.from({ length: 20 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 20 }, (_, i) => `new ${i}`).join("\n");
    expect(diffLines(before, after).changed).toBe(20);
  });

  test("an empty side is the whole other side", () => {
    expect(diffLines("", "a\nb").changed).toBe(2);
    expect(diffLines("a\nb", "").changed).toBe(2);
  });

  test("a file past the guard still answers, and says the answer is approximate", () => {
    // O(n·m) has a ceiling; what matters is that the fallback is LOUD about
    // being one, and that it errs upward — a metric that flatters the writer
    // is worse than one that does not.
    const huge = Array.from({ length: 3_100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const changed = `${huge}\nextra`;
    const diff = diffLines(huge, changed);
    expect(diff.approximate).toBe(true);
    expect(diff.changed).toBeGreaterThan(0);
  });
});
