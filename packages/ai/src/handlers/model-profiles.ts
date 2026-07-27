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
import { reasoningLevelSchema } from "@fretik/shared/schemas/reasoning";
import { getTeamAiSettings } from "@fretik/shared/services/team-ai-settings/get-for-team";
import { upsertTeamAiSettings } from "@fretik/shared/services/team-ai-settings/upsert";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  getFamilyBranding,
  getModelDisplayName,
} from "../lib/model-registry/display";
import { MODEL_PROFILES } from "../lib/model-registry/profiles";
import {
  isSelectableForTier,
  listProfilesForTierDisplay,
  recommendedProfileKeyForTier,
  selectableReasoningLevels,
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
  tier: ModelTier,
  recommendedKey: string,
  metrics: ModelMetricsSnapshot,
) => {
  const branding = getFamilyBranding(profile.family);
  const metric = metrics.metrics[profile.key];
  const { assessment, catalog } = profile;
  return {
    key: profile.key,
    displayName: getModelDisplayName(profile.key),
    family: profile.family,
    costClass: assessment.costClass,
    recommended: profile.key === recommendedKey,
    icon: branding.icon,
    brandColor: branding.brandColor,
    brandGradient: branding.brandGradient ?? null,
    inputModalities: catalog.inputModalities,
    /**
     * What the model reads NATIVELY, which is what a user actually experiences
     * — `inputModalities` is the upstream ceiling, and the two differ (audio is
     * accepted by five models and activated on none).
     */
    nativeModalities: [
      ...(assessment.nativeInput.image ? ["image"] : []),
      ...(assessment.nativeInput.video ? ["video"] : []),
      ...(assessment.nativeInput.fileMimeTypes.length > 0 ? ["file"] : []),
      ...(assessment.nativeInput.audio ? ["audio"] : []),
    ],
    contextLength: catalog.contextLength,
    /** Zero-data-retention routing. `false` for the Mistral family only. */
    zeroDataRetention: assessment.provider.zdr === true,
    /**
     * Whether the team may pick this card. Disabled models are STILL RETURNED
     * so the picker can show them greyed out with `disabledReason`; the client
     * must not treat presence in `options` as permission.
     */
    selectable: isSelectableForTier(profile, tier),
    disabledReason: assessment.disabledReason ?? null,
    intelligence: metric?.intelligence ?? null,
    speed: metric?.speed ?? null,
    costLevel: metric?.costLevel ?? null,
    timeToFirstAnswer: metric?.timeToFirstAnswer ?? null,
    coding: metric?.coding ?? null,
    toolUse: metric?.toolUse ?? null,
    instructionFollowing: metric?.instructionFollowing ?? null,
    longContext: metric?.longContext ?? null,
    /**
     * The depths a user may actually request — the SINGLE signal driving the
     * reasoning picker, in the prompt bar and on a workflow. Not the raw
     * upstream ladder: `selectableReasoningLevels` drops single-rung ladders and
     * models whose knob is pinned or measured inert. **Empty ⇒ no choice**, and
     * the UI then explains itself instead of showing a dead control.
     *
     * A separate `steerable` boolean used to ride along here. It was removed
     * because nothing read it and it could contradict this list — a profile with
     * a pinned reasoning budget has an upstream ladder yet no usable choice.
     */
    reasoningLevels: selectableReasoningLevels(profile),
    defaultReasoningLevel: assessment.reasoning.defaultLevel,
  };
};

const modelProfilesRoutes = new OpenAPIHono<HonoLoggedAppType>();
modelProfilesRoutes.use("*", authMiddleware);

/**
 * GET /model-profiles — the picker menu. For each tier: EVERY profile listing
 * that tier (with display + live metrics), the team's current selection, the
 * recommended (code-default) key, and the effective key. Serves the prompt-bar
 * flagship picker AND the model hub settings page.
 *
 * `options` includes models the team cannot currently pick — each card carries
 * `selectable` + `disabledReason` so the hub renders them greyed out with an
 * explanation. Authorisation lives on the PATCH below, never in this list.
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
      const options = listProfilesForTierDisplay(tier).map((profile) =>
        buildCard(profile, tier, recommended, metrics),
      );
      const selected = selectedByTier[tier];
      return [
        tier,
        { options, selected, recommended, effective: selected ?? recommended },
      ];
    }),
  );

  /**
   * The team's thinking-depth default for its flagship model. Flagship-only by
   * design (the other tiers' effort is a calibrated part of their role
   * envelope, not a preference), so it sits beside `tiers` rather than inside
   * each one. `stored` is what the team chose — `null` means "whatever the
   * model does by default", which the client reads off the card's
   * `defaultReasoningLevel`.
   */
  const flagshipEffectiveKey =
    selectedByTier.flagship ?? recommendedProfileKeyForTier("flagship");
  const flagshipProfile = MODEL_PROFILES[flagshipEffectiveKey];
  const storedLevel = settings?.flagshipReasoningLevel ?? null;

  return c.json({
    tiers,
    reasoning: {
      // Echoed back only if the effective model still accepts it: a stored
      // level can outlive a model swap, and showing a depth we would silently
      // ignore is worse than showing the model's own default.
      stored:
        flagshipProfile &&
        selectableReasoningLevels(flagshipProfile).some(
          (level) => level === storedLevel,
        )
          ? storedLevel
          : null,
    },
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
  /**
   * Thinking depth for the team's flagship model. `null` resets it to the
   * model's own default. Omitted leaves it alone — EXCEPT when `flagship`
   * changes, which clears it (see `upsertTeamAiSettings`).
   */
  flagshipReasoningLevel: reasoningLevelSchema.nullish(),
});

/**
 * Reject a tier override the team may not pick — the authorisation counterpart
 * to the display list above, which deliberately returns disabled models too.
 * Unknown key, wrong tier, or `enabled: false` all 400 here.
 */
const assertSelectable = (
  key: string | null | undefined,
  tier: ModelTier,
): void => {
  if (key === undefined || key === null) return;
  const profile = MODEL_PROFILES[key];
  if (!profile) {
    throwHttpError(400, badRequest(`"${key}" is not a known model`));
    return;
  }
  if (!isSelectableForTier(profile, tier)) {
    throwHttpError(
      400,
      badRequest(
        profile.assessment.enabled
          ? `"${key}" is not available as a ${tier} model`
          : `"${key}" is not available on your plan yet`,
      ),
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

  const { flagship, workhorse, utility, flagshipReasoningLevel } = parsed.data;
  assertSelectable(flagship, "flagship");
  assertSelectable(workhorse, "workhorse");
  assertSelectable(utility, "utility");
  // A depth is only meaningful against a model. Validate it against the model
  // this request LEAVES in effect — the one being set here, or the one already
  // stored — so "high" can never be pinned onto a model whose ladder lacks it.
  if (flagshipReasoningLevel) {
    const stored = await getTeamAiSettings(team.id);
    const targetKey =
      flagship ??
      stored?.flagshipProfileKey ??
      recommendedProfileKeyForTier("flagship");
    const target = MODEL_PROFILES[targetKey];
    if (
      !target ||
      !selectableReasoningLevels(target).some(
        (level) => level === flagshipReasoningLevel,
      )
    ) {
      return throwHttpError(
        400,
        badRequest(
          `"${flagshipReasoningLevel}" is not a thinking depth "${targetKey}" supports`,
        ),
      );
    }
  }

  const settings = await upsertTeamAiSettings({
    teamId: team.id,
    flagshipProfileKey: flagship,
    workhorseProfileKey: workhorse,
    utilityProfileKey: utility,
    flagshipReasoningLevel,
  });

  return c.json({
    flagship: settings.flagshipProfileKey,
    workhorse: settings.workhorseProfileKey,
    utility: settings.utilityProfileKey,
    // Returned because the caller cannot predict it: switching model clears it.
    flagshipReasoningLevel: settings.flagshipReasoningLevel,
  });
});

export { modelProfilesRoutes };
