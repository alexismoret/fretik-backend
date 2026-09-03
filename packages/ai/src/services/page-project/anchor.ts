/**
 * Finding the text an edit means, when the text it SENT is a little off.
 *
 * Exact search-replace is the format models write best (Diff-XYZ, 2026: it
 * beats unified diff and line-addressed formats at every size), but the way it
 * fails is brittle in one specific direction: a model reproduces the code
 * correctly and the WHITESPACE approximately — a tab where the file has four
 * spaces, a trailing space dropped, a block re-indented as it was quoted. The
 * anchor then matches nothing, and the model's own repair is to widen it, which
 * is how an edit ends up costing more than the file it edits.
 *
 * So the anchor is looked for four times, in decreasing strictness, and the
 * FIRST strategy that finds it wins. Every one of them is exact about what the
 * code says; they differ only in how much they care about the spaces between.
 *
 * Nothing here guesses at CONTENT. A strategy that matched on similarity would
 * edit a line the model never looked at, silently — which is the one failure
 * worse than a refusal.
 */

/** How the anchor was found; reported so a surprising replacement is explicable. */
export type AnchorStrategy =
  "exact" | "trailing-whitespace" | "inner-whitespace" | "indentation";

export interface AnchorMatch {
  /** Character offsets into the text. */
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
  /** Indentation of the matched block's first line, for re-indenting. */
  indent: string;
}

export type AnchorLookup =
  | { found: true; strategy: AnchorStrategy; matches: AnchorMatch[] }
  | { found: false };

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
};

const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? "";

/** Trailing spaces and tabs gone; everything else untouched. */
const trimEnd = (line: string): string => line.replace(/[ \t]+$/, "");

/** Runs of spaces and tabs collapsed to one, both ends trimmed. */
const collapse = (line: string): string => line.trim().replace(/[ \t]+/g, " ");

/** Leading indentation gone, trailing whitespace gone. */
const deindent = (line: string): string => trimEnd(line).replace(/^[ \t]+/, "");

const NORMALIZERS: Record<
  Exclude<AnchorStrategy, "exact">,
  (line: string) => string
> = {
  "trailing-whitespace": trimEnd,
  "inner-whitespace": collapse,
  indentation: deindent,
};

/** Every exact occurrence, as offsets. */
const exactMatches = (text: string, needle: string): AnchorMatch[] => {
  const matches: AnchorMatch[] = [];
  let at = text.indexOf(needle);
  while (at !== -1) {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    matches.push({
      start: at,
      end: at + needle.length,
      line: text.slice(0, at).split("\n").length,
      indent: indentOf(text.slice(lineStart, at + needle.length)),
    });
    at = text.indexOf(needle, at + Math.max(needle.length, 1));
  }
  return matches;
};

/**
 * Line-window search under a normalizer. A fuzzy match always covers WHOLE
 * lines: the anchor's own line boundaries are the only thing left to trust
 * once the spaces inside them are negotiable.
 */
const windowMatches = (
  text: string,
  needle: string,
  normalize: (line: string) => string,
): AnchorMatch[] => {
  const lines = text.split("\n");
  const starts = lineStarts(text);
  const wanted = needle.split("\n").map(normalize);
  if (wanted.length === 0) return [];
  const haystack = lines.map(normalize);
  const matches: AnchorMatch[] = [];
  for (let index = 0; index + wanted.length <= haystack.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (haystack[index + offset] !== wanted[offset]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    const start = starts[index] ?? 0;
    const lastIndex = index + wanted.length - 1;
    const end = (starts[lastIndex] ?? 0) + (lines[lastIndex]?.length ?? 0);
    matches.push({
      start,
      end,
      line: index + 1,
      indent: indentOf(lines[index] ?? ""),
    });
  }
  return matches;
};

export const findAnchor = (text: string, needle: string): AnchorLookup => {
  const exact = exactMatches(text, needle);
  if (exact.length > 0)
    return { found: true, strategy: "exact", matches: exact };
  // Ordered by how much they forgive, least first: `indentation` ignores what
  // is before a line, `inner-whitespace` also ignores what is inside it. A
  // more permissive strategy placed earlier would swallow the ones after it
  // and the reported strategy would stop meaning anything.
  for (const strategy of [
    "trailing-whitespace",
    "indentation",
    "inner-whitespace",
  ] as const) {
    const matches = windowMatches(text, needle, NORMALIZERS[strategy]);
    if (matches.length > 0) return { found: true, strategy, matches };
  }
  return { found: false };
};

/**
 * The replacement, re-indented to where it is going.
 *
 * Only for a match found by ignoring indentation: the model quoted the block
 * flat, or one level off, and inserting its replacement verbatim would leave a
 * correctly-edited file with a visibly broken shape.
 */
export const reindent = (
  replacement: string,
  needle: string,
  match: AnchorMatch,
): string => {
  const wantedIndent = indentOf(needle.split("\n")[0] ?? "");
  if (wantedIndent === match.indent) return replacement;
  return replacement
    .split("\n")
    .map((line, index) => {
      if (index === 0) return line.replace(/^[ \t]*/, match.indent);
      if (line.trim() === "") return line;
      const own = indentOf(line);
      const relative = own.startsWith(wantedIndent)
        ? own.slice(wantedIndent.length)
        : own;
      return `${match.indent}${relative}${line.slice(own.length)}`;
    })
    .join("\n");
};

/** Spaces and tabs made visible, so a whitespace mismatch can be SEEN. */
export const visualiseWhitespace = (line: string): string =>
  line.replace(/\t/g, "→").replace(/ /g, "·");

/**
 * The line this anchor was probably aiming at.
 *
 * Similarity over the anchor's first non-trivial line, because that is what a
 * model gets right when it gets the whitespace wrong. Returns nothing rather
 * than a poor guess: "did you mean this?" pointing at the wrong line is worse
 * than "not found".
 */
export const didYouMean = (
  text: string,
  needle: string,
  context = 2,
): string | null => {
  const probe = needle
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 8);
  if (probe === undefined) return null;

  const lines = text.split("\n");
  let bestIndex = -1;
  let bestScore = 0;
  for (const [index, line] of lines.entries()) {
    const score = similarity(collapse(line), collapse(probe));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  if (bestIndex === -1 || bestScore < 0.6) return null;

  const from = Math.max(0, bestIndex - context);
  const window = lines
    .slice(from, bestIndex + context + 1)
    .map(
      (line, offset) =>
        `${(from + offset + 1).toString().padStart(4, " ")}\t${visualiseWhitespace(line)}`,
    )
    .join("\n");
  return [
    `Did you mean this? (· is a space, → a tab; the line numbers are not part of the file)`,
    window,
  ].join("\n");
};

/** Dice coefficient over character bigrams — cheap, and stable on short lines. */
const similarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let hits = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) {
      pairs.set(pair, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
};
