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
 * The flagship model + thinking depth a chat turn or workflow run should use.
 *
 * Resolution order for the MODEL: an explicit pin (a workflow's
 * `modelProfileKey`) → the team's stored flagship pick → the code default.
 * Before 2026-07-27 the chat path skipped the middle step, because the prompt
 * bar stamped the team's pick onto every new conversation. That picker is gone —
 * teams choose a model once, in settings — so unpinned conversations must read
 * the team's choice here or it would be silently ignored.
 *
 * `storedReasoningLevel` is only returned when the resolved model IS the team's
 * effective flagship: the level was chosen against that specific model (see the
 * reset rule in `upsertTeamAiSettings`), so it must not leak onto a workflow
 * pinned to something else — whose own `reasoningLevel` column applies instead.
 * Raw here, validated by `effectiveReasoningLevel` at the call site.
 */
export interface TeamFlagshipSelection {
  profileKey: string;
  /** True when a pin/stored key was unusable and the default took over. */
  fellBack: boolean;
  storedReasoningLevel: string | null;
}

export const resolveTeamFlagship = async (
  teamId: string | undefined,
  pinnedKey: string | null | undefined,
): Promise<TeamFlagshipSelection> => {
  // Same defensive read as `resolveModelForTeam`: a Redis/DB hiccup on a
  // personalization read must degrade to the code default, never break a turn.
  // try/catch rather than `.catch()` — the read can throw synchronously before
  // a promise exists.
  let settings = null;
  if (teamId !== undefined) {
    try {
      settings = await withSoftTimeout(
        getTeamAiSettings(teamId),
        3000,
        null,
        "team-ai-settings",
      );
    } catch (err) {
      console.error(
        `[team-model] settings read failed for team=${teamId} — using code default:`,
        err,
      );
    }
  }

  const teamFlagship = resolveTierProfileKey(
    "flagship",
    settings?.flagshipProfileKey,
  ).profileKey;

  const resolved = pinnedKey
    ? resolveTierProfileKey("flagship", pinnedKey)
    : { profileKey: teamFlagship, fellBack: false };

  return {
    profileKey: resolved.profileKey,
    fellBack: resolved.fellBack,
    storedReasoningLevel:
      resolved.profileKey === teamFlagship
        ? (settings?.flagshipReasoningLevel ?? null)
        : null,
  };
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
