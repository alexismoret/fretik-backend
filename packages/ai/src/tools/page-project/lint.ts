import {
  formatPageLintFinding,
  lintPageFile,
  newLintFindings,
  type PageLintFinding,
} from "@fretik/shared/services/pages/lint";

/**
 * What a write or an edit INTRODUCED — never what the file already carried.
 *
 * A page that opens with five warnings would otherwise report all five on
 * every call, and the one line just changed would be invisible among them
 * (hermes-agent reached the same conclusion for the same reason). The delta is
 * also the only form in which a lint is safe to attach to a write: the agent
 * is mid-build, and a list it did not cause is a list it learns to skip.
 *
 * Errors first: a `fabricated-rows` error will refuse the build, so learning
 * about it on the write that caused it costs one edit instead of a build.
 */

/** Past this the delta stops being a fix list. */
const MAX_DELTA = 6;

const ORDER = { error: 0, blocking: 1, warning: 2 } as const;

export const lintDelta = (
  path: string,
  before: string | undefined,
  after: string,
): { lintDelta?: string[]; lintRefusesBuild?: true } => {
  let introduced: PageLintFinding[];
  try {
    introduced = newLintFindings(
      before === undefined ? [] : lintPageFile(path, before),
      lintPageFile(path, after),
    );
  } catch {
    // A lint that throws is a bug in the lint, and it must never be the reason
    // a write fails: the file is already saved by the time this runs.
    return {};
  }
  if (introduced.length === 0) return {};
  const sorted = [...introduced].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || a.line - b.line,
  );
  const refuses = sorted.some((finding) => finding.severity === "error");
  return {
    lintDelta: sorted.slice(0, MAX_DELTA).map(formatPageLintFinding),
    ...(refuses ? { lintRefusesBuild: true as const } : {}),
  };
};
