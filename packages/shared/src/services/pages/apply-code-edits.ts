import { PAGE_LIMITS, type PageCodeEdit } from "../../schemas/pages";

/**
 * Apply targeted edits to a page's SFC source — the artifact-style update
 * channel. Exact-match-once semantics, same contract as an editor's
 * search-replace: an `oldString` that matches nothing or matches twice is a
 * STALE VIEW of the source, and silently picking an occurrence would edit a
 * line the agent was not looking at. The error says which edit failed and why;
 * the fix is to `get` the page and re-anchor.
 *
 * Edits apply IN ORDER, each against the previous result, so a later edit may
 * target text an earlier one introduced.
 */
/** Lines of context returned around a near-miss. Enough to re-anchor on, short
 * enough that the answer is cheaper than re-reading the file. */
const NEAR_MISS_CONTEXT = 3;

/**
 * The exact current text around where the edit ALMOST matched.
 *
 * A failed anchor is nearly always a whitespace or indentation drift, not a
 * wrong place — measured on a real run (2026-08-16) where the agent reported
 * "the anchors have a different indentation from the saved code" and then
 * resent the whole SFC twice. Telling it to `get` and re-anchor made that
 * retreat rational: a full read costs the same as a full rewrite, so it did
 * both. Handing back the real lines removes the reason to reread and the
 * reason to rewrite.
 *
 * The probe is the first non-blank line of `oldString`, trimmed. Whitespace is
 * what drifts, so matching on the trimmed line finds the place precisely when
 * the exact match failed for the usual reason.
 */
const nearMiss = (source: string, oldString: string): string | null => {
  const probe = oldString
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 8);
  if (!probe) return null;

  const lines = source.split("\n");
  const hits = lines.flatMap((line, index) =>
    line.includes(probe) ? [index] : [],
  );
  // Several hits and there is no "the" place to show; none and the anchor was
  // aimed somewhere this source never had.
  if (hits.length !== 1) return null;

  const at = hits[0] ?? 0;
  const from = Math.max(0, at - NEAR_MISS_CONTEXT);
  const window = lines
    .slice(from, at + NEAR_MISS_CONTEXT + 1)
    .map((line, offset) => `${(from + offset + 1).toString()}\t${line}`)
    .join("\n");
  return `The source has this at line ${(at + 1).toString()} — copy the anchor from it verbatim, whitespace included (the line numbers and the tab after them are not part of the source):\n${window}`;
};

export const applyPageCodeEdits = (
  source: string,
  edits: PageCodeEdit[],
): { ok: true; source: string } | { ok: false; error: string } => {
  let current = source;
  for (const [index, edit] of edits.entries()) {
    const label = `edit ${(index + 1).toString()}/${edits.length.toString()}`;
    if (edit.oldString === edit.newString) {
      return {
        ok: false,
        error: `${label}: oldString and newString are identical — nothing to change.`,
      };
    }
    const occurrences = current.split(edit.oldString).length - 1;
    if (occurrences === 0) {
      const context = nearMiss(current, edit.oldString);
      return {
        ok: false,
        error: context
          ? `${label}: oldString not found. ${context}`
          : `${label}: oldString not found in the current source, and nothing close to it either — the anchor points at text this page does not have. Call { action: "get" } and re-anchor.`,
      };
    }
    if (occurrences > 1 && !edit.replaceAll) {
      return {
        ok: false,
        error: `${label}: oldString occurs ${occurrences.toString()} times — widen it until it is unique, or set replaceAll: true to change every occurrence.`,
      };
    }
    current = edit.replaceAll
      ? current.split(edit.oldString).join(edit.newString)
      : current.replace(edit.oldString, edit.newString);
  }
  if (current.length > PAGE_LIMITS.maxSourceChars) {
    return {
      ok: false,
      error: `the edited source is ${current.length.toString()} chars; the ceiling is ${PAGE_LIMITS.maxSourceChars.toString()}.`,
    };
  }
  return { ok: true, source: current };
};
