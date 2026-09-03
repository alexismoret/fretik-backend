import type { PageLintFinding } from "./types";

/**
 * A file past the norm — advice, never a refusal.
 *
 * The schema's ceiling is twice these numbers on purpose (`PAGE_LIMITS`
 * comment): a file a little over gets a sentence telling it what to split,
 * while the hard limit exists only to stop a runaway. What makes the norm worth
 * stating at all is the measured cost of a long file — the whole reason a page
 * became a project: a fix touching 7% of a 2 000-line SFC re-emitted all of it,
 * three times in a row (2026-08-28).
 */

export const LINT_FILE_LINES = 300;
export const LINT_FILE_CHARS = 12_000;

export const lintFileSize = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const lines = source === "" ? 0 : source.split("\n").length;
  if (lines <= LINT_FILE_LINES && source.length <= LINT_FILE_CHARS) return [];
  return [
    {
      path,
      line: 0,
      rule: "file-size",
      severity: "warning",
      message: `${lines.toString()} lines, ${source.length.toString()} chars — past the ${LINT_FILE_LINES.toString()}-line norm. Move a region into its own components/<Name>.vue: it is usable as <Name> with no import, and the next fix then rewrites that file instead of this one.`,
    },
  ];
};
