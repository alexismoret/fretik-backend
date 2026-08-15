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
      return {
        ok: false,
        error: `${label}: oldString not found in the current source. Call { action: "get" } and re-anchor the edit on the exact current text.`,
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
