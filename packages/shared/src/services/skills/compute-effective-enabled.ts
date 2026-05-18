/**
 * Pure rule for "is this skill enabled for this team right now?".
 * Kept in its own module (no DB / no env imports) so the unit test
 * can lock the contract without spinning up Postgres — the sibling
 * `list-for-team.ts` pulls `db` at module load and would otherwise
 * drag a `DATABASE_URL` requirement into the test process.
 *
 * Contract:
 *   - Always-on skills (`isDefault = true`) are enabled forever; any
 *     stale row in `team_skills` for them is intentionally ignored
 *     here (the upsert service refuses to write one in the first
 *     place, but defence-in-depth: the rule wins even if a row exists).
 *   - Configurable skills follow the team's explicit override when
 *     present, otherwise default-on (today every configurable skill
 *     ships enabled — flipping the default to off later is a one-line
 *     change here without schema churn).
 */
export const computeEffectiveEnabled = (
  isDefault: boolean,
  overrideEnabled: boolean | null,
): boolean => {
  if (isDefault) return true;
  return overrideEnabled ?? true;
};
