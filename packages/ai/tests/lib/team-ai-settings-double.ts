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
type ProfileKeys = Pick<
  TeamAiSettings,
  "flagshipProfileKey" | "workhorseProfileKey" | "utilityProfileKey"
> &
  Partial<Pick<TeamAiSettings, "flagshipReasoningLevel">>;

let settings: ProfileKeys | null = null;
let shouldThrow = false;

export const getTeamAiSettings = (
  _teamId: string,
): Promise<ProfileKeys | null> => {
  if (shouldThrow) throw new Error("settings store down");
  return Promise.resolve(settings);
};

export const setTeamAiSettingsDouble = (
  next: ProfileKeys | null,
  throwing = false,
): void => {
  settings = next;
  shouldThrow = throwing;
};
