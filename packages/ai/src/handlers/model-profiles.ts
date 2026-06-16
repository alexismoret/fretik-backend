import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import {
  badRequest,
  teamRequired,
  throwHttpError,
  validationError,
} from "@fretik/shared/lib/errors";
import { getTeamAiSettings } from "@fretik/shared/services/team-ai-settings/get-for-team";
import { upsertTeamAiSettings } from "@fretik/shared/services/team-ai-settings/upsert";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  getFamilyBranding,
  getModelDisplayName,
} from "../lib/model-registry/display";
import {
  MODEL_PROFILES,
  STEERABLE_REASONING_KEYS,
} from "../lib/model-registry/profiles";
import {
  isSelectableForTier,
  listSelectableProfilesForTier,
  recommendedProfileKeyForTier,
} from "../lib/model-registry/resolve";
import type { ModelProfile, ModelTier } from "../lib/model-registry/types";
import { getModelMetrics } from "../services/model-metrics/get";
import {
  ARTIFICIAL_ANALYSIS_URL,
  type ModelMetricsSnapshot,
} from "../services/model-metrics/types";

/**
 * User-facing model selection endpoints (chantier C8). Lives in @fretik/ai —
 * NOT @fretik/api — because both reads (selectable profiles + display) and the
 * write validation need the in-package model registry, which @fretik/api
 * cannot import. The frontend already talks to this service directly.
 */

const TIERS: readonly ModelTier[] = ["flagship", "workhorse", "utility"];

const buildCard = (
  profile: ModelProfile,
  recommendedKey: string,
  metrics: ModelMetricsSnapshot,
) => {
  const branding = getFamilyBranding(profile.family);
  const metric = metrics.metrics[profile.key];
  return {
    key: profile.key,
    displayName: getModelDisplayName(profile.key),
    family: profile.family,
    costClass: profile.assessment.costClass,
    recommended: profile.key === recommendedKey,
    icon: branding.icon,
    brandColor: branding.brandColor,
    brandGradient: branding.brandGradient ?? null,
    inputModalities: profile.catalog.inputModalities,
    intelligence: metric?.intelligence ?? null,
    speed: metric?.speed ?? null,
    costLevel: metric?.costLevel ?? null,
    // C7 — whether the "extended thinking" toggle is meaningful for this model
    // (gates the switch in the picker). Adaptive/inert models (e.g. M3) → false.
    steerable: STEERABLE_REASONING_KEYS.has(profile.key),
  };
};

const modelProfilesRoutes = new OpenAPIHono<HonoLoggedAppType>();
modelProfilesRoutes.use("*", authMiddleware);

/**
 * GET /model-profiles — the picker menu. For each tier: the gate-passed
 * selectable profiles (with display + live metrics), the team's current
 * selection, the recommended (code-default) key, and the effective key.
 * Serves the prompt-bar flagship picker AND the 3-tier settings page.
 */
modelProfilesRoutes.get("/", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const [metrics, settings] = await Promise.all([
    getModelMetrics(),
    getTeamAiSettings(team.id),
  ]);

  const selectedByTier: Record<ModelTier, string | null> = {
    flagship: settings?.flagshipProfileKey ?? null,
    workhorse: settings?.workhorseProfileKey ?? null,
    utility: settings?.utilityProfileKey ?? null,
  };

  const tiers = Object.fromEntries(
    TIERS.map((tier) => {
      const recommended = recommendedProfileKeyForTier(tier);
      const options = listSelectableProfilesForTier(tier).map((profile) =>
        buildCard(profile, recommended, metrics),
      );
      const selected = selectedByTier[tier];
      return [
        tier,
        { options, selected, recommended, effective: selected ?? recommended },
      ];
    }),
  );

  return c.json({
    tiers,
    attribution: {
      provider: "Artificial Analysis",
      url: ARTIFICIAL_ANALYSIS_URL,
    },
    metricsFetchedAt: metrics.fetchedAt,
  });
});

const teamDefaultsSchema = z.object({
  flagship: z.string().nullish(),
  workhorse: z.string().nullish(),
  utility: z.string().nullish(),
});

/** Reject a tier override that is not a gate-passed profile of that tier. */
const assertSelectable = (
  key: string | null | undefined,
  tier: ModelTier,
): void => {
  if (key === undefined || key === null) return;
  const profile = MODEL_PROFILES[key];
  if (!profile || !isSelectableForTier(profile, tier)) {
    throwHttpError(
      400,
      badRequest(`"${key}" is not a selectable ${tier} model`),
    );
  }
};

/**
 * PATCH /model-profiles/team-defaults — set the team's per-tier defaults.
 * Admin/owner only. Each provided key is validated against the registry;
 * `null` resets a tier to the code default, omitted leaves it unchanged.
 */
modelProfilesRoutes.patch("/team-defaults", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  await assertOrgAdmin({
    userId: user.id,
    organizationId: team.organizationId,
  });

  const parsed = teamDefaultsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return throwHttpError(
      400,
      validationError(
        parsed.error.issues.map((i) => i.message),
        "Invalid request body",
      ),
    );
  }

  const { flagship, workhorse, utility } = parsed.data;
  assertSelectable(flagship, "flagship");
  assertSelectable(workhorse, "workhorse");
  assertSelectable(utility, "utility");

  const settings = await upsertTeamAiSettings({
    teamId: team.id,
    flagshipProfileKey: flagship,
    workhorseProfileKey: workhorse,
    utilityProfileKey: utility,
  });

  return c.json({
    flagship: settings.flagshipProfileKey,
    workhorse: settings.workhorseProfileKey,
    utility: settings.utilityProfileKey,
  });
});

export { modelProfilesRoutes };
