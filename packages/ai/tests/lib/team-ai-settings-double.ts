/**
 * In-memory stand-in for `@fretik/shared/services/team-ai-settings/get-for-team`,
 * registered globally from `tests/preload.ts` (NOT from an individual test
 * file). `resolveModelForTeam` / `cheapModelIdForTeam` are reachable from many
 * unrelated unit tests (memory services, compaction, search, pre-extract, the
 * full chatbot agent set), so whichever test file happens to import that chain
 * FIRST in the shared bun test process permanently binds `team-model.ts`'s
 * `getTeamAiSettings` reference — a LATER `mock.module()` call from a specific
 * test file only wins if nothing upstream already cached the real module,
 * which is execution-order dependent and was observed to differ between local
 * runs (macOS) and CI (Linux): the real, Redis-backed implementation ran in
 * CI, and with `maxRetriesPerRequest: null` on the unreachable test Redis URL,
 * every call hung until the soft-timeout / test timeout fired.
 *
 * Preloading this stub guarantees `getTeamAiSettings` never touches Redis in
 * ANY unit test, regardless of file order. Tests that need specific settings
 * values (`model-registry-team.test.ts`) call `setTeamAiSettingsDouble()`
 * instead of `mock.module()`.
 */
import type { TeamAiSettings } from "@fretik/shared/db/schema";

// Only the columns some call site in `team-model.ts` reads — the double omits
// teamId/createdAt/updatedAt so test literals stay minimal. Optional so a
// literal can keep listing just the tier keys it cares about.
type ProfileKeys = Partial<Pick<TeamAiSettings, "assistantReasoningLevel">> & {
  /**
   * Optional in the literal, always present on the way OUT: every reader
   * goes through `functionProfileKey`, which reads this first and only then
   * falls back to the legacy tier columns. A double that omitted it would
   * make the fallback path the only one any test ever exercises.
   */
  functionProfileKeys?: TeamAiSettings["functionProfileKeys"];
};

let settings: ProfileKeys | null = null;
let shouldThrow = false;

export const getTeamAiSettings = (
  _teamId: string,
): Promise<
  | (ProfileKeys & {
      functionProfileKeys: TeamAiSettings["functionProfileKeys"];
    })
  | null
> => {
  if (shouldThrow) throw new Error("settings store down");
  if (settings === null) return Promise.resolve(null);
  return Promise.resolve({
    ...settings,
    functionProfileKeys: settings.functionProfileKeys ?? {},
  });
};

export const setTeamAiSettingsDouble = (
  next: ProfileKeys | null,
  throwing = false,
): void => {
  settings = next;
  shouldThrow = throwing;
};
