import { describe, expect, test } from "bun:test";
import { applyPageCodeEdits } from "../../src/services/pages/apply-code-edits";

/**
 * The page surface's answer to a failed anchor, which differs from the
 * document surface's on purpose.
 *
 * A page update carries many anchors — 37 changed sites per update, median 31,
 * measured over 33 real builds (2026-08-23). Refusing all of them because one
 * drifted bills a full re-emission of a write that was mostly correct, and
 * re-emitting is the single most expensive thing the builder does. Keeping
 * what landed is safe here and nowhere else: the write path compiles the
 * result, so a half-applied change that does not build never reaches storage.
 */
describe("applyPageCodeEdits — partial application", () => {
  const SOURCE = "<template>\n  <p>a</p>\n  <p>b</p>\n</template>\n";

  test("edits that match are kept, and the misses are named", () => {
    const result = applyPageCodeEdits(SOURCE, [
      { oldString: "<p>a</p>", newString: "<p>A</p>" },
      { oldString: "<p>gone</p>", newString: "<p>X</p>" },
      { oldString: "<p>b</p>", newString: "<p>B</p>" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("<p>A</p>");
    expect(result.source).toContain("<p>B</p>");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(2);
  });

  test("a clean batch reports no failures", () => {
    const result = applyPageCodeEdits(SOURCE, [
      { oldString: "<p>a</p>", newString: "<p>A</p>" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.failures).toHaveLength(0);
  });

  test("every anchor missing is a stale view, not a partial write", () => {
    // Nothing landed, so there is no salvage — and the agent is working from a
    // stale copy of the whole file rather than one line that drifted.
    const result = applyPageCodeEdits(SOURCE, [
      { oldString: "<p>gone</p>", newString: "<p>X</p>" },
      { oldString: "<p>also-gone</p>", newString: "<p>Y</p>" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("edit 1/2");
  });

  test("the `after` landmark reaches a repeated anchor without widening it", () => {
    const repeated =
      '<UCard title="Open">\n  <UBadge color="neutral" />\n</UCard>\n' +
      '<UCard title="Overdue">\n  <UBadge color="neutral" />\n</UCard>\n';
    const result = applyPageCodeEdits(repeated, [
      {
        after: 'title="Overdue"',
        oldString: 'color="neutral"',
        newString: 'color="error"',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe(
      '<UCard title="Open">\n  <UBadge color="neutral" />\n</UCard>\n' +
        '<UCard title="Overdue">\n  <UBadge color="error" />\n</UCard>\n',
    );
  });
});
