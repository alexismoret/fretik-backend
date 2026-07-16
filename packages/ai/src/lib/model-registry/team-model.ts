/**
 * C8b — per-team workhorse / utility model resolution. The DB-backed layer on
 * top of the pure registry in `resolve.ts`: read a team's stored tier picks
 * (C8a), degrade unknown / unselectable keys to the code default, and return
 * the model instance under the requested ROLE's envelope.
 *
 * Kept separate from `resolve.ts` (which stays pure, no DB import) so the
 * registry logic remains unit-testable without Redis / Postgres.
 */

import { getTeamAiSettings } from "@fretik/shared/services/team-ai-settings/get-for-team";
import { withSoftTimeout } from "../stream-errors";
import {
  ROLE_TIER,
  resolveModel,
  resolveModelForRoleProfile,
  resolveTierProfileKey,
  type ResolvedModel,
} from "./resolve";
import type { ModelRole } from "./types";

/**
 * Resolve a role to the model instance a team should use, honouring its
 * stored workhorse / utility pick. Falls back to the role's code default when:
 * the role is `"fixed"` (never overridable), no `teamId` is in scope (a
 * context-less background path), the team has no override, the override is
 * unknown / gate-failed / wrong-tier, OR the settings read errors.
 *
 * The settings read is wrapped defensively: a Redis/DB hiccup on this
 * personalization read must never break a chat turn or a background pipeline,
 * so any failure — including a Redis connection that hangs instead of
 * erroring (`maxRetriesPerRequest: null` queues forever rather than
 * rejecting) — degrades to the code default rather than blocking.
 */
export const resolveModelForTeam = async (
  role: ModelRole,
  teamId: string | undefined,
): Promise<ResolvedModel> => {
  const tier = ROLE_TIER[role];
  if (tier === "fixed" || teamId === undefined) return resolveModel(role);
  try {
    const settings = await withSoftTimeout(
      getTeamAiSettings(teamId),
      3000,
      null,
      "team-ai-settings",
    );
    const storedKey =
      tier === "flagship"
        ? settings?.flagshipProfileKey
        : tier === "workhorse"
          ? settings?.workhorseProfileKey
          : settings?.utilityProfileKey;
    const { profileKey } = resolveTierProfileKey(tier, storedKey);
    return resolveModelForRoleProfile(role, profileKey);
  } catch (err) {
    console.error(
      `[team-model] settings read failed for team=${teamId} role=${role} — using code default:`,
      err,
    );
    return resolveModel(role);
  }
};

/**
 * Resolve a role for a memory pipeline, with an eval-only profile override:
 * when `profileOverride` is set the model is forced onto that registry profile
 * under the role's own envelope (the model bake-off across recall + the
 * distillers); otherwise it honours the team's pick like `resolveModelForTeam`.
 * Prod call sites pass `undefined` and behave exactly as before.
 */
export const resolveMemoryModel = async (
  role: ModelRole,
  teamId: string | undefined,
  profileOverride?: string,
): Promise<ResolvedModel> =>
  profileOverride
    ? resolveModelForRoleProfile(role, profileOverride)
    : resolveModelForTeam(role, teamId);

/**
 * The utility-tier model ID a team should use for `bare` one-shot call sites
 * (titles, catch-up, multi-query) that build their own
 * `openrouter.chat(id, settings)` and need the catalog ID string, not a
 * wrapped instance. Falls back to the `cheap-tasks` code default.
 */
export const cheapModelIdForTeam = async (
  teamId: string | undefined,
): Promise<string> =>
  (await resolveModelForTeam("cheap-tasks", teamId)).profile.catalog.id;
