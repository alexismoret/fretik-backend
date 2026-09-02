import { normalizeProviderName } from "./provider-names";

/**
 * Hosts a measurement disqualified for one model, kept where a human can read
 * the reason.
 *
 * ## Why this file exists at all
 *
 * Everything else about a pool is computed. These are not: they record that
 * somebody ran a probe, watched a host mangle an answer, and decided. The sync
 * carries `ignore` forward across passes precisely so a judgment survives, and
 * the design note on that carry-forward says why — an exclusion that lives only
 * as an accident of the computed list is "self-perpetuating while nothing
 * moves, and gone the moment the pool widens".
 *
 * That is exactly what happened. When the curated profiles were deleted
 * (2026-08-30) their `only` lists became the row's `only`, and the two DeepSeek
 * exclusions below survived not as judgments but as absences — held in place by
 * a filtering bug. Removing the bug (2026-09-02) would have re-admitted both
 * hosts on the next pass, silently, to the model they were measured breaking.
 *
 * ## What belongs here
 *
 * Only a defect somebody MEASURED, with the measurement in the comment. Not a
 * preference, not a price, not a speed — those are what the pool computes and
 * what `sort` orders. A host that is merely slow belongs at the end of the
 * pool, not out of it.
 *
 * ## What does not
 *
 * A defect the runtime can see for itself. The breaker files incidents from
 * real traffic and quarantines a host after five in two hours; that path needs
 * no entry here and never did. This list is for what a probe found and traffic
 * would not — the failures rare enough to escape the counter but bad enough to
 * matter every time.
 */
export interface MeasuredExclusion {
  /** Normalised upstream name, the spelling a pool and a quarantine both use. */
  provider: string;
  /** What was measured, and when. Read by whoever wonders if it still holds. */
  reason: string;
}

const EXCLUSIONS: Record<string, MeasuredExclusion[]> = {
  "deepseek-v4-flash": [
    {
      provider: "together",
      reason:
        "2026-08-13: truncated answers mid-sentence at the tool-call boundary. Every agent turn ends in a tool call, so the failure lands on the shape of turn this model serves most.",
    },
    {
      provider: "coreweave",
      reason:
        "2026-08-28: inserted U+200B and fullwidth punctuation next to NUMBERS in emitted text — reproduced 2 runs of 3, against 0 of 3 on DeepInfra and 0 of 2 on Fireworks.",
    },
  ],
};

/** The measured exclusions for one model, empty when none were recorded. */
export const measuredExclusionsFor = (
  profileKey: string,
): readonly MeasuredExclusion[] => EXCLUSIONS[profileKey] ?? [];

/**
 * The `ignore` list a row should carry: what it already carries, plus what was
 * measured. A union, never a replacement — the row's own entries may have been
 * written by a path this file knows nothing about.
 */
export const withMeasuredExclusions = (
  profileKey: string,
  ignore: readonly string[] | undefined,
): string[] => [
  ...new Set([
    ...(ignore ?? []).map(normalizeProviderName),
    ...measuredExclusionsFor(profileKey).map((entry) =>
      normalizeProviderName(entry.provider),
    ),
  ]),
];
