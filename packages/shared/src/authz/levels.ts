import { ACCESS_LEVELS, type AccessLevel } from "../schemas/access";

/**
 * Arithmetic on access levels. A level is compared by its position in
 * `ACCESS_LEVELS` (view < use < edit < full), the same order Postgres uses for
 * the `access_level` enum — which is what lets the SQL filters and these
 * helpers agree without a translation table.
 *
 * `null` means "no access at all" and sorts below every level.
 */

const RANK: Readonly<Record<AccessLevel, number>> = {
  view: 1,
  use: 2,
  edit: 3,
  full: 4,
};

export const levelRank = (level: AccessLevel | null): number =>
  level === null ? 0 : RANK[level];

/** True when `level` reaches `required`. */
export const atLeast = (
  level: AccessLevel | null,
  required: AccessLevel,
): boolean => levelRank(level) >= RANK[required];

/** The highest of the given levels, or null when none gives access. */
export const maxLevel = (
  ...levels: ReadonlyArray<AccessLevel | null | undefined>
): AccessLevel | null => {
  let best: AccessLevel | null = null;
  for (const level of levels) {
    if (level !== undefined && levelRank(level) > levelRank(best)) {
      best = level;
    }
  }
  return best;
};

/** The lower of two levels: `level` capped at `cap`. */
export const capLevel = (
  level: AccessLevel | null,
  cap: AccessLevel | null,
): AccessLevel | null => (levelRank(level) <= levelRank(cap) ? level : cap);

/** Every level from `minimum` up, for `level IN (…)` style filters. */
export const levelsAtLeast = (minimum: AccessLevel): AccessLevel[] =>
  ACCESS_LEVELS.filter((level) => RANK[level] >= RANK[minimum]);
