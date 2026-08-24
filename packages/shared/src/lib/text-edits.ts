/**
 * Targeted search-replace edits on a text document — the artifact-style update
 * channel shared by every surface an agent edits in place (a page's SFC source,
 * an authored markdown document).
 *
 * EXACT STRING ANCHORS, NOT LINE NUMBERS. Line numbers look safer and are not:
 * they go stale silently. If the text moved since the agent read it, "line 40"
 * now holds different content and the edit corrupts it without a word, whereas
 * a string anchor fails loudly. Several edits in one call also shift each
 * other's line numbers, so a line-addressed batch has to be applied backwards
 * or offset-corrected — two more ways to be wrong. This is also what Claude
 * Code's Edit tool does, down to instructing the model to STRIP the line-number
 * prefix out of what it read before composing an anchor.
 *
 * Exact-match-once semantics, same contract as an editor's search-replace: an
 * `oldString` matching nothing, or matching twice without `replaceAll`, means
 * the agent is working from a STALE VIEW. Silently picking an occurrence would
 * edit a line it was not looking at, so both cases are refused with an error
 * that says which edit failed and why. `after` narrows WHERE the anchor is
 * looked for, which is how an anchor stays short in text that repeats itself.
 *
 * Two contracts sit on top: `applyTextEdits` refuses the batch on the first
 * failure, `runTextEdits` reports every edit's fate and leaves the keep-or-
 * discard call to the surface.
 *
 * Edits apply IN ORDER, each against the previous result, so a later edit may
 * target text an earlier one introduced.
 *
 * What this function CANNOT do is notice that the whole document changed under
 * the agent — an anchor can still match in a text someone else rewrote. That
 * guard belongs at the call site, which must pair the edit with the revision
 * the agent read (`manageDocument`'s `revision`, `documents.fileHash`).
 */

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  /**
   * A landmark that must appear exactly once, after which `oldString` is
   * matched. This is the answer to the cost the uniqueness rule imposes on
   * REPETITIVE text: a page's SFC holds twenty near-identical cards, so an
   * anchor aimed at one of them has to be widened until it swallows enough
   * surrounding lines to be unique — and both halves of that widened block
   * are then re-emitted as output. Measured over 33 real updates
   * (2026-08-23): 119 lines of `oldString` per update against 155 lines of
   * new content, 77% of the write spent re-typing code that already existed.
   * A landmark plus a short local anchor is two lines where widening was
   * fifteen.
   */
  after?: string;
}

export type TextEditResult =
  { ok: true; text: string } | { ok: false; error: string };

/** One edit that did not apply, numbered the way the agent sent it. */
export interface TextEditFailure {
  /** 1-based, matching the `edit N/M` label in `error`. */
  index: number;
  error: string;
}

/**
 * The result of attempting every edit, whether or not they all landed.
 *
 * `text` carries the edits that DID apply. Whether a partial result is worth
 * keeping is the CALL SITE's decision, not this function's: a page has a
 * compiler to catch a half-applied state before it is stored, an authored
 * document has nothing, so they answer differently. `fatal` is the case
 * neither can keep — the result breaks a ceiling.
 */
export interface TextEditOutcome {
  text: string;
  applied: number;
  failures: TextEditFailure[];
  fatal?: string;
}

/** Lines of context returned around a near-miss. Enough to re-anchor on, short
 * enough that the answer is cheaper than re-reading the whole text. */
const NEAR_MISS_CONTEXT = 3;

/**
 * The exact current text around where the edit ALMOST matched.
 *
 * A failed anchor is nearly always a whitespace or indentation drift, not a
 * wrong place — measured on a real run (2026-08-16) where the agent reported
 * "the anchors have a different indentation from the saved code" and then
 * resent the whole source twice. Telling it to re-read made that retreat
 * rational: a full read costs the same as a full rewrite, so it did both.
 * Handing back the real lines removes the reason to reread and the reason to
 * rewrite.
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

interface TextEditOptions {
  maxChars: number;
  /** What the ceiling applies to, for the over-length error ("source", "document"). */
  subject: string;
  /**
   * How THIS surface's agent gets a fresh copy, appended to the "anchor
   * matched nothing" error. The recovery differs per surface — a page is
   * re-read with `managePage { action: "get" }`, a document with
   * `manageDocument { action: "get" }` — and a wrong instruction here sends
   * the agent down a path that does not exist.
   */
  reanchorHint: string;
}

/**
 * Apply one edit, or say why it did not apply.
 *
 * Edits are INDEPENDENT of each other's success: a failure here leaves
 * `current` untouched and the caller moves to the next one. What they are not
 * independent of is each other's RESULT — an edit may target text an earlier
 * one introduced — which is why they still run in order against the running
 * text rather than all against the original.
 */
const applyOne = (
  current: string,
  edit: TextEdit,
  label: string,
  options: TextEditOptions,
): { ok: true; text: string } | { ok: false; error: string } => {
  if (edit.oldString === edit.newString) {
    return {
      ok: false,
      error: `${label}: oldString and newString are identical — nothing to change.`,
    };
  }
  // The landmark bounds the search. It is held to the same exact-match-once
  // rule as the anchor itself — a landmark that is not unique would move the
  // whole edit somewhere the agent never looked.
  let head = "";
  let region = current;
  if (edit.after !== undefined) {
    if (edit.after.length === 0) {
      return {
        ok: false,
        error: `${label}: after is empty — omit it instead.`,
      };
    }
    const landmarks = current.split(edit.after).length - 1;
    if (landmarks === 0) {
      const context = nearMiss(current, edit.after);
      return {
        ok: false,
        error: context
          ? `${label}: the \`after\` landmark was not found. ${context}`
          : `${label}: the \`after\` landmark is not in the current ${options.subject}. ${options.reanchorHint}`,
      };
    }
    if (landmarks > 1) {
      return {
        ok: false,
        error: `${label}: the \`after\` landmark occurs ${landmarks.toString()} times — it has to be unique, because it is what makes the short anchor after it unambiguous.`,
      };
    }
    const at = current.indexOf(edit.after) + edit.after.length;
    head = current.slice(0, at);
    region = current.slice(at);
  }

  const occurrences = region.split(edit.oldString).length - 1;
  if (occurrences === 0) {
    const context = nearMiss(region, edit.oldString);
    const where = edit.after === undefined ? "" : " after that landmark";
    return {
      ok: false,
      error: context
        ? `${label}: oldString not found${where}. ${context}`
        : `${label}: oldString not found${where} in the current ${options.subject}, and nothing close to it either — the anchor points at text this ${options.subject} does not have. ${options.reanchorHint}`,
    };
  }
  if (occurrences > 1 && !edit.replaceAll) {
    return {
      ok: false,
      error:
        edit.after === undefined
          ? `${label}: oldString occurs ${occurrences.toString()} times — set \`after\` to a unique landmark that precedes the one you mean (cheaper), widen the anchor until it is unique, or set replaceAll: true to change every occurrence.`
          : `${label}: oldString occurs ${occurrences.toString()} times after that landmark — move \`after\` closer to the occurrence you mean, or set replaceAll: true.`,
    };
  }
  const edited = edit.replaceAll
    ? region.split(edit.oldString).join(edit.newString)
    : region.replace(edit.oldString, edit.newString);
  return { ok: true, text: head + edited };
};

/**
 * Run every edit and report what landed. Nothing is refused wholesale here —
 * see `TextEditOutcome` for who decides whether a partial result is keepable.
 */
export const runTextEdits = (
  source: string,
  edits: TextEdit[],
  options: TextEditOptions,
): TextEditOutcome => {
  let current = source;
  let applied = 0;
  const failures: TextEditFailure[] = [];
  for (const [index, edit] of edits.entries()) {
    const label = `edit ${(index + 1).toString()}/${edits.length.toString()}`;
    const result = applyOne(current, edit, label, options);
    if (!result.ok) {
      failures.push({ index: index + 1, error: result.error });
      continue;
    }
    current = result.text;
    applied += 1;
  }
  if (current.length > options.maxChars) {
    return {
      text: source,
      applied: 0,
      failures,
      fatal: `the edited ${options.subject} is ${current.length.toString()} chars; the ceiling is ${options.maxChars.toString()}.`,
    };
  }
  return { text: current, applied, failures };
};

/**
 * All-or-nothing wrapper. The contract for surfaces with no downstream check
 * on a half-applied result — an authored document has no compiler to catch one.
 */
export const applyTextEdits = (
  source: string,
  edits: TextEdit[],
  options: TextEditOptions,
): TextEditResult => {
  const outcome = runTextEdits(source, edits, options);
  if (outcome.fatal) return { ok: false, error: outcome.fatal };
  const first = outcome.failures[0];
  if (first) return { ok: false, error: first.error };
  return { ok: true, text: outcome.text };
};
