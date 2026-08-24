import { runTextEdits, type TextEditFailure } from "../../lib/text-edits";
import { PAGE_LIMITS, type PageCodeEdit } from "../../schemas/pages";

/**
 * Apply targeted edits to a page's SFC source.
 *
 * The mechanism — exact string anchors, refuse on ambiguity, near-miss context
 * on a failed anchor — lives in `lib/text-edits`, shared with document
 * authoring. This file supplies what is specific to a page: its size ceiling
 * and the way its agent gets a fresh copy.
 *
 * PARTIAL, unlike the document surface. A page update carries many anchors —
 * 37 changed sites per update, measured over 33 real ones (2026-08-23) — and
 * refusing all of them because one drifted costs a full re-emission of a write
 * the agent had already got right. The compiler is what makes keeping the rest
 * safe: a half-applied change that does not compile is refused downstream by
 * the write path, so the only states that reach storage are ones that build.
 */
export const applyPageCodeEdits = (
  source: string,
  edits: PageCodeEdit[],
):
  | { ok: true; source: string; failures: TextEditFailure[] }
  | { ok: false; error: string } => {
  const outcome = runTextEdits(source, edits, {
    maxChars: PAGE_LIMITS.maxSourceChars,
    subject: "source",
    reanchorHint: 'Call { action: "get" } and re-anchor.',
  });
  if (outcome.fatal) return { ok: false, error: outcome.fatal };
  // Every anchor missed: there is no partial result to keep, and the agent is
  // working from a stale view of the whole file rather than one drifted line.
  if (outcome.applied === 0) {
    const first = outcome.failures[0];
    return {
      ok: false,
      error: first?.error ?? "no edits were applied.",
    };
  }
  return { ok: true, source: outcome.text, failures: outcome.failures };
};
