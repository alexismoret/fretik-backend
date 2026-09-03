/**
 * What a lint has to say about one line of one file.
 *
 * Three severities, because there are exactly three things a finding can do,
 * and conflating them was how the old single `warnings` channel lost the
 * important ones in a list of advice:
 *
 * - `error` — the build refuses. Reserved for a defect that makes the page a
 *   LIE (rows nobody's data produced): it looks right, so nothing downstream
 *   can catch it, and shipping it is worse than not shipping.
 * - `blocking` — the build passes, the review fails. A defect a person hits
 *   but a compiler cannot see: a native control where a component belongs.
 * - `warning` — reported, gates nothing. Advice, and a page may ship over it.
 */
export type PageLintSeverity = "error" | "blocking" | "warning";

export interface PageLintFinding {
  path: string;
  /** 1-indexed, in the file named by `path`. 0 when the file as a whole is the finding. */
  line: number;
  /** Which rule fired — the stable name, for grouping and for tests. */
  rule: string;
  severity: PageLintSeverity;
  /** One sentence: what is wrong, then what to do instead. */
  message: string;
}

/** `components/LaneBoard.vue:41 — <select> …` — how a finding reaches an agent. */
export const formatPageLintFinding = (finding: PageLintFinding): string =>
  finding.line > 0
    ? `${finding.path}:${finding.line.toString()} — ${finding.message}`
    : `${finding.path} — ${finding.message}`;
