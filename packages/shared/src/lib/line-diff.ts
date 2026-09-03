/**
 * How many lines actually differ between two versions of a file.
 *
 * The number the page builder is measured on: a fix that changed 7% of a file
 * re-emitted 100% of it, and neither half of that sentence existed as a metric
 * until this. Lines rather than characters because a line is the unit a person
 * reads a diff in, and because character-level distance calls a re-indent a
 * rewrite.
 *
 * Longest-common-subsequence over lines, with a guard: LCS is O(n·m), so past
 * the guard it falls back to counting the lines that differ pairwise. The
 * fallback OVERSTATES a change that shifted lines, which is the safe direction
 * — a metric that flatters the writer is worse than one that does not.
 */

/** Past this many lines on either side, the exact table costs more than it is worth. */
const LCS_LINE_GUARD = 3_000;

export interface LineDiff {
  /** Lines present in `after` and not matched in `before`. */
  added: number;
  /** Lines present in `before` and not matched in `after`. */
  removed: number;
  /** What a person would call "the size of this change". */
  changed: number;
  /** True when the cheap fallback produced these numbers. */
  approximate: boolean;
}

const pairwise = (before: string[], after: string[]): LineDiff => {
  const shared = Math.min(before.length, after.length);
  let same = 0;
  for (let index = 0; index < shared; index += 1) {
    if (before[index] === after[index]) same += 1;
  }
  const added = after.length - same;
  const removed = before.length - same;
  return {
    added,
    removed,
    changed: Math.max(added, removed),
    approximate: true,
  };
};

export const diffLines = (before: string, after: string): LineDiff => {
  if (before === after) {
    return { added: 0, removed: 0, changed: 0, approximate: false };
  }
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length === 0 || b.length === 0) {
    return {
      added: b.length,
      removed: a.length,
      changed: Math.max(a.length, b.length),
      approximate: false,
    };
  }
  if (a.length > LCS_LINE_GUARD || b.length > LCS_LINE_GUARD) {
    return pairwise(a, b);
  }

  // One row at a time: the full table would be 9M numbers at the guard.
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  const common = previous[b.length] ?? 0;
  const added = b.length - common;
  const removed = a.length - common;
  return {
    added,
    removed,
    // A modified line is one removal and one addition; counting it twice would
    // say a one-line change touched two.
    changed: Math.max(added, removed),
    approximate: false,
  };
};
