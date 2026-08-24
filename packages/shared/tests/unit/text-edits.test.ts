import { describe, expect, test } from "bun:test";
import { applyTextEdits, runTextEdits } from "../../src/lib/text-edits";

/**
 * The shared search-replace channel (page SFC source, authored markdown).
 *
 * The contract worth pinning is what it REFUSES. Exact string anchors are only
 * safe because ambiguity is never resolved by guessing: an anchor matching
 * twice is a stale view of the text, and silently picking an occurrence would
 * edit a line the caller was not looking at. That refusal — not the
 * replacement — is why this beats line-addressed edits, which would apply
 * cleanly to whatever now sits at that line number.
 */

const OPTIONS = {
  maxChars: 1000,
  subject: "document",
  reanchorHint: 'Call { action: "get" } and re-anchor.',
};

const edit = (oldString: string, newString: string, replaceAll?: boolean) =>
  replaceAll === undefined
    ? { oldString, newString }
    : { oldString, newString, replaceAll };

describe("applyTextEdits — what it refuses", () => {
  test("an ambiguous anchor is refused, never resolved by guessing", () => {
    const result = applyTextEdits(
      "total: 10\ntotal: 20\n",
      [edit("total:", "sum:")],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("occurs 2 times");
      // The recovery must be actionable, and every way out is named — the
      // cheapest one first, since widening is what makes an update expensive.
      expect(result.error).toContain("after");
      expect(result.error).toContain("widen");
      expect(result.error).toContain("replaceAll");
    }
  });

  test("replaceAll is the explicit opt-in for every occurrence", () => {
    const result = applyTextEdits(
      "total: 10\ntotal: 20\n",
      [edit("total:", "sum:", true)],
      OPTIONS,
    );
    expect(result).toEqual({ ok: true, text: "sum: 10\nsum: 20\n" });
  });

  test("widening the anchor makes it unique — the intended fix", () => {
    const result = applyTextEdits(
      "total: 10\ntotal: 20\n",
      [edit("total: 20", "total: 25")],
      OPTIONS,
    );
    expect(result).toEqual({ ok: true, text: "total: 10\ntotal: 25\n" });
  });

  test("a no-op edit is refused rather than silently accepted", () => {
    const result = applyTextEdits("hello", [edit("hello", "hello")], OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("identical");
  });

  test("an over-long result is refused, and says by how much", () => {
    const result = applyTextEdits("x", [edit("x", "y".repeat(2000))], {
      ...OPTIONS,
      maxChars: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("the ceiling is 100");
  });
});

describe("applyTextEdits — near-miss recovery", () => {
  test("a drifted anchor gets the real lines back, not just a refusal", () => {
    // The common failure: the agent's anchor spans several lines and its
    // indentation drifted from what is stored, so nothing matches even though
    // the place is obvious. Handing back the actual text removes the reason to
    // re-read the whole document AND the reason to rewrite it wholesale.
    //
    // Note a single-line anchor usually survives a drift on its own, since the
    // stored line merely CONTAINS it — the trap is the multi-line block.
    const source = "intro\n    const total = 10\n    return total\noutro\n";
    const result = applyTextEdits(
      source,
      [edit("  const total = 10\n  return total", "  return 20")],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("line 2");
      expect(result.error).toContain("    const total = 10");
    }
  });

  test("an anchor aimed at absent text falls back to the surface's hint", () => {
    const result = applyTextEdits(
      "nothing like it here\n",
      [edit("a completely unrelated anchor", "x")],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Call { action: "get" }');
      expect(result.error).toContain("document");
    }
  });
});

describe("applyTextEdits — ordering", () => {
  test("edits apply in order, each against the previous result", () => {
    const result = applyTextEdits(
      "a\n",
      [edit("a", "b"), edit("b", "c")],
      OPTIONS,
    );
    expect(result).toEqual({ ok: true, text: "c\n" });
  });

  test("a failing edit aborts the batch and names its position", () => {
    const result = applyTextEdits(
      "a\n",
      [edit("a", "b"), edit("zzz", "c")],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("edit 2/2");
  });
});

/**
 * `after` exists because the uniqueness rule is what makes an edit expensive
 * in REPETITIVE text. A page's SFC holds twenty near-identical cards; without
 * a way to say WHERE to look, the only way to reach one of them is to widen
 * the anchor until it swallows enough surrounding lines to be unique — and
 * every one of those lines is then emitted twice, as `oldString` and again as
 * `newString`. Measured over 33 real page updates (2026-08-23): 119 anchor
 * lines against 155 lines of actual new content.
 */
describe("runTextEdits — the `after` landmark", () => {
  const REPEATED = [
    "card one",
    "  label: 'Total'",
    "card two",
    "  label: 'Total'",
    "",
  ].join("\n");

  test("a short anchor reaches the occurrence the landmark points at", () => {
    const result = applyTextEdits(
      REPEATED,
      [
        {
          after: "card two",
          oldString: "label: 'Total'",
          newString: "label: 'Sum'",
        },
      ],
      OPTIONS,
    );
    expect(result).toEqual({
      ok: true,
      text: "card one\n  label: 'Total'\ncard two\n  label: 'Sum'\n",
    });
  });

  test("the landmark scopes the search — it does not pick the next occurrence", () => {
    // `after: "card one"` leaves BOTH labels in the region, so the anchor is
    // still ambiguous and still refused. The landmark buys a place to start
    // looking, never a licence to guess which match was meant.
    const result = applyTextEdits(
      REPEATED,
      [
        {
          after: "card one",
          oldString: "label: 'Total'",
          newString: "label: 'Sum'",
        },
      ],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("move `after` closer");
  });

  test("ambiguity BEFORE the landmark stops mattering", () => {
    const result = applyTextEdits(
      "label: 'Total'\nlabel: 'Total'\nfooter\nlabel: 'Total'\n",
      [
        {
          after: "footer",
          oldString: "label: 'Total'",
          newString: "label: 'Sum'",
        },
      ],
      OPTIONS,
    );
    expect(result).toEqual({
      ok: true,
      text: "label: 'Total'\nlabel: 'Total'\nfooter\nlabel: 'Sum'\n",
    });
  });

  test("an ambiguous landmark is refused — it would move the whole edit", () => {
    const result = applyTextEdits(
      "x\nsection\ny\nsection\nz\n",
      [{ after: "section", oldString: "y", newString: "w" }],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("occurs 2 times");
  });

  test("an anchor that exists only BEFORE the landmark is a miss, not a silent skip", () => {
    const result = applyTextEdits(
      "target\nlandmark\ntail\n",
      [{ after: "landmark", oldString: "target", newString: "x" }],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("after that landmark");
  });
});

/**
 * Partial application is the page surface's contract, not the document's —
 * see `services/pages/apply-code-edits`. The engine's job is only to report
 * every edit's fate so each surface can answer for itself.
 */
describe("runTextEdits — reporting what landed", () => {
  test("edits that match are kept even when a sibling misses", () => {
    const outcome = runTextEdits(
      "a\nb\n",
      [edit("a", "A"), edit("zzz", "Z"), edit("b", "B")],
      OPTIONS,
    );
    expect(outcome.text).toBe("A\nB\n");
    expect(outcome.applied).toBe(2);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.index).toBe(2);
  });

  test("a ceiling breach keeps nothing — there is no partial version of too big", () => {
    const outcome = runTextEdits("x", [edit("x", "y".repeat(2000))], OPTIONS);
    expect(outcome.fatal).toBeDefined();
    expect(outcome.text).toBe("x");
    expect(outcome.applied).toBe(0);
  });

  test("applyTextEdits still refuses the batch on the first failure", () => {
    const result = applyTextEdits(
      "a\nb\n",
      [edit("a", "A"), edit("zzz", "Z")],
      OPTIONS,
    );
    expect(result.ok).toBe(false);
  });
});
