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
import type { UnmetRequirement } from "@fretik/shared/model-registry/eligibility";
import type { ModelFunctionKey } from "@fretik/shared/model-registry/functions";
import {
  functionProfileKey,
  isModelFunctionKey,
  MODEL_FUNCTION_KEYS,
} from "@fretik/shared/model-registry/functions";
import { reasoningLevelSchema } from "@fretik/shared/schemas/reasoning";
import { countIncidentsForModels } from "@fretik/shared/services/model-registry/incidents";
import { getLiveStateSync } from "@fretik/shared/services/model-registry/live";
import { getTeamAiSettings } from "@fretik/shared/services/team-ai-settings/get-for-team";
import { upsertTeamAiSettings } from "@fretik/shared/services/team-ai-settings/upsert";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  getFamilyBranding,
  getModelDisplayName,
} from "../lib/model-registry/display";
import { getEffectiveProfile } from "../lib/model-registry/effective";
import {
  functionsForProfile,
  selectableForFunction,
  unmetForFunction,
} from "../lib/model-registry/functions";
import {
  listProfilesForFunctionDisplay,
  recommendedProfileKeyForFunction,
  selectableReasoningLevels,
} from "../lib/model-registry/resolve";
import type { ModelProfile } from "../lib/model-registry/types";
import { getModelMetrics } from "../services/model-metrics/get";
import {
  ARTIFICIAL_ANALYSIS_URL,
  artificialAnalysisModelUrl,
  type ModelMetricsSnapshot,
} from "../services/model-metrics/types";

/**
 * User-facing model selection endpoints (chantier C8). Lives in @fretik/ai —
 * NOT @fretik/api — because both reads (selectable profiles + display) and the
 * write validation need the in-package model registry, which @fretik/api
 * cannot import. The frontend already talks to this service directly.
 */

/**
 * How much incident history a card reports. A week, not a day: these are rare
 * events by design — the breaker quarantines a host after three in an hour —
 * so a 24 h window reads as zero on a model that had a bad Tuesday.
 */
const INCIDENT_WINDOW_HOURS = 24 * 7;

/**
 * One model, described for display.
 *
 * Everything here is a property of the MODEL — never of the (model, function)
 * pair. That is what lets the response carry the fleet once instead of once per
 * function: whether a team may pick a model for `documents`, and which model
 * `documents` recommends, live in the function's own entry.
 */
export const buildCard = (
  profile: ModelProfile,
  context: {
    metrics: ModelMetricsSnapshot;
    /** Incidents per model key over `INCIDENT_WINDOW_HOURS`; absent = none. */
    incidents: Map<string, number>;
  },
) => {
  const { metrics } = context;
  const branding = getFamilyBranding(profile.family);
  const metric = metrics.metrics[profile.key];
  const { assessment, catalog } = profile;
  // Live state when the snapshot is warm; the curated facts otherwise. A picker
  // that empties because a metadata table is unreachable would be a worse
  // failure than a slightly optimistic context figure.
  const live = getLiveStateSync(profile.key);
  return {
    key: profile.key,
    displayName: getModelDisplayName(profile.key),
    family: profile.family,
    costClass: assessment.costClass,
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
    /**
     * The window a request can actually use: the SMALLEST any reachable
     * endpoint offers, less a safety margin, as measured by the nightly sync.
     * The catalogue headline is the fallback and is optimistic — endpoints for
     * one model span 262 144 to 1 048 576 tokens, and routing picks one per
     * request, so quoting the largest tells a team it has room it does not.
     */
    contextLength: live?.effectiveContextLength ?? catalog.contextLength,
    /**
     * When the model came out, ISO date, from the upstream catalogue. `null`
     * before the first sync, or for a model no source dates.
     *
     * A sort and filter axis, not a quality signal: newer is not better, and a
     * default ordering on it would put an untested release above a model the
     * fleet has run for months. It answers the other question a team asks of a
     * catalogue — "what is new since I last looked".
     */
    releasedAt: live?.releasedAt?.toISOString() ?? null,
    /** Zero-data-retention routing. `false` for the Mistral family only. */
    zeroDataRetention: assessment.provider.zdr === true,
    /**
     * How the engine currently grades the model's serving, from live uptime,
     * throughput and this week's incidents. `null` before the first sync.
     *
     * Shown so a team can tell "this model is slow today" from "I chose badly".
     * A model the engine had to disable outright never reaches this field — it
     * is already unselectable, with `disabledReason` saying why.
     */
    health: live?.health === "unknown" ? null : (live?.health ?? null),
    /**
     * How the engine grades this model's SERVING, and what it graded from.
     *
     * A SaaS built on models someone else runs depends on how well they are
     * being run, and until now the only thing a team could see was a
     * three-value badge that appeared solely when the news was bad. These four
     * numbers are what the badge is computed from, so "healthy" stops being an
     * assertion the product makes about itself.
     *
     * AGNOSTIC BY CONSTRUCTION: aggregates and counts, never a host's name. The
     * engine routes one model across several companies and moves between them
     * without asking, so naming one would be both a leak and a lie — and a test
     * builds a card from a fixture with named endpoints and asserts no name
     * survives into the JSON.
     */
    serving: {
      /** 0-100 composite, dominated by uptime. `null` before the first sync. */
      score: live?.healthScore ?? null,
      /** Best 1-day uptime across the reachable pool, as a percentage. */
      uptime1d:
        live === undefined
          ? null
          : (live.endpointStats
              .map((endpoint) => endpoint.uptime1d)
              .filter((value): value is number => value !== undefined)
              .sort((a, b) => b - a)[0] ?? null),
      /**
       * How many upstreams can serve it. One is not a failure and is worth
       * seeing: it means an outage there is an outage here, with nothing to
       * route around it.
       */
      poolSize: live?.endpointStats.length ?? null,
      /** Our OWN traffic's incidents this week — corruption, cuts, stalls. */
      incidents7d: context.incidents.get(profile.key) ?? 0,
      /** When the engine last measured any of this. */
      checkedAt: live?.syncedAt?.toISOString() ?? null,
    },
    /**
     * The functions this model MEASURES UP TO — a positive badge, and a
     * stricter question than `selectable`: this grants only on a measured pass,
     * so a model nobody has graded is offerable without being advertised.
     * Empty means "not enough data", never "good for nothing".
     */
    eligibleFunctions: functionsForProfile(profile, live ?? undefined),
    /**
     * Curation first, then the live row.
     *
     * A TypeScript profile that says `disabled: cost` is a reviewed decision
     * and outranks a measurement. But the engine can now disable a model on its
     * own — a price that rose past the budget, a policy streak — and reading
     * only the profile left those cards greyed out with NO explanation, which
     * reads as a bug rather than as a decision.
     */
    disabledReason: assessment.disabledReason ?? live?.disabledReason ?? null,
    intelligence: metric?.intelligence ?? null,
    speed: metric?.speed ?? null,
    costLevel: metric?.costLevel ?? null,
    /**
     * How many times this model costs the fleet's cheapest, per turn. A
     * MULTIPLE, never a price — the dollar figure stays in `model-metrics`.
     *
     * `costLevel` alone cannot answer "how much more does this one cost me":
     * it is log-scaled on purpose, so the same three-point gap means 10 % at
     * one end of the fleet and 2× at the other.
     */
    costRatio: metric?.costRatio ?? null,
    timeToFirstAnswer: metric?.timeToFirstAnswer ?? null,
    /**
     * p50 time to the FIRST token on the endpoint this profile is most likely
     * to land on. Distinct from `timeToFirstAnswer`, which counts the wait
     * until the first ANSWER token and so includes a reasoning model's silent
     * thinking. Both this and `speed` were computed and cached but never sent,
     * which left the panel describing whichever route Artificial Analysis
     * happened to sample rather than ours.
     */
    ttftSeconds: metric?.ttftSeconds ?? null,
    coding: metric?.coding ?? null,
    /**
     * Where Artificial Analysis publishes THIS model's benchmarks. Their
     * licence requires the credit; sending the model's own page rather than the
     * site root makes the credit useful as well as compliant. Falls back to the
     * root for a model AA does not cover.
     */
    attributionUrl: artificialAnalysisModelUrl(assessment.aaSlug),
    /**
     * Agentic capability. Sourced from Artificial Analysis' composite agentic
     * index since 2026-08-30 — the per-benchmark `tau_banking` it used to carry
     * is Pro-only on the migrated API. Scale changed from 0-1 to ~0-100.
     */
    toolUse: metric?.toolUse ?? null,
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
 * GET /model-profiles — the picker menu, in two halves: `models`, the fleet
 * described once with display + live metrics, and `functions`, what the team
 * controls (which models each function accepts, what it chose, what the code
 * recommends). Serves the model hub settings page AND the workflow model modal.
 *
 * `models` includes models the team cannot currently pick — absent from a
 * function's `selectable`, and carrying `disabledReason` when the engine took
 * them out entirely — so the hub renders them greyed out with an explanation.
 * Authorisation lives on the PATCH below, never in this list.
 */
modelProfilesRoutes.get("/", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const profiles = listProfilesForFunctionDisplay();
  const profileKeys = profiles.map((profile) => profile.key);
  const [metrics, settings, incidents] = await Promise.all([
    getModelMetrics(),
    getTeamAiSettings(team.id),
    // ONE grouped count for the whole page. Never fatal: a hub that fails to
    // render because an infra table is slow is worse than one showing no
    // incident history.
    countIncidentsForModels(
      profileKeys,
      INCIDENT_WINDOW_HOURS,
      new Date(),
    ).catch((err: unknown) => {
      console.warn("[model-profiles] incident counts unavailable:", err);
      return new Map<string, number>();
    }),
  ]);

  /**
   * The fleet, described ONCE.
   *
   * Every function offers the WHOLE fleet rather than pre-filtering the way the
   * tier menus it replaces did: hiding the models a function cannot use answers
   * "why is this one missing" with silence, where a greyed card with a reason
   * answers it. Serialising that fleet inside each of the seven menus would then
   * have sent the same 139 cards seven times — a ~700 kB response describing
   * 139 models. The cards are model facts, so they belong beside the menus, not
   * inside them.
   */
  const models = profiles.map((profile) =>
    buildCard(profile, { metrics, incidents }),
  );

  /**
   * The menu a team controls, one entry per function: which of those models the
   * function accepts, what the team chose, and what the code recommends.
   *
   * `selectable` is a list of KEYS into `models` because selectability is a
   * property of the (model, function) pair — the same model is offerable for
   * `documents` and refused for `recall`.
   *
   * `unmet` is the other half of that pair: WHY the ones missing from
   * `selectable` are missing. Without it a greyed row can only say "not
   * compatible", which reads as an arbitrary product decision rather than as
   * "its window is 131k and this job needs 256k". Populated only where a
   * MEASUREMENT refused — a model the engine took out entirely already carries
   * `disabledReason` on its card, and repeating that in seven menus would say
   * the same thing seven times.
   */
  const functions = Object.fromEntries(
    MODEL_FUNCTION_KEYS.map((fn) => {
      const recommended = recommendedProfileKeyForFunction(fn);
      const selectable: string[] = [];
      const unmet: Record<string, UnmetRequirement[]> = {};
      for (const profile of profiles) {
        if (selectableForFunction(profile, fn)) {
          selectable.push(profile.key);
          continue;
        }
        // The card's OWN reading of "out of service", so the two can never
        // disagree about which explanation a row already carries.
        const live = getLiveStateSync(profile.key);
        if (
          (profile.assessment.disabledReason ??
            live?.disabledReason ??
            null) !== null
        )
          continue;
        const requirements = unmetForFunction(profile, fn, live);
        if (requirements.length > 0) unmet[profile.key] = requirements;
      }
      const selected = functionProfileKey(settings, fn) ?? null;
      return [
        fn,
        {
          selectable,
          unmet,
          selected,
          recommended,
          effective: selected ?? recommended,
        },
      ];
    }),
  );

  /**
   * The team's thinking-depth default for its ASSISTANT model. Assistant-only
   * by design (every other function's effort is a calibrated part of its role
   * envelope, not a preference), so it sits beside `functions` rather than
   * inside each one. `stored` is what the team chose — `null` means "whatever the
   * model does by default", which the client reads off the card's
   * `defaultReasoningLevel`.
   */
  const assistantEffectiveKey =
    functionProfileKey(settings, "assistant") ??
    recommendedProfileKeyForFunction("assistant");
  const assistantProfile = getEffectiveProfile(assistantEffectiveKey);
  const storedLevel = settings?.assistantReasoningLevel ?? null;

  return c.json({
    models,
    functions,
    reasoning: {
      // Echoed back only if the effective model still accepts it: a stored
      // level can outlive a model swap, and showing a depth we would silently
      // ignore is worse than showing the model's own default.
      stored:
        assistantProfile &&
        selectableReasoningLevels(assistantProfile).some(
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
  /**
   * The team's model per function, sparse: a key absent here is left alone, a
   * key set to `null` is reset to the code default. Unknown function names and
   * models the function cannot use are rejected below rather than stored.
   */
  functions: z.record(z.string(), z.string().nullish()).optional(),
  /**
   * Thinking depth for the team's ASSISTANT model. `null` resets it to the
   * model's own default. Omitted leaves it alone — EXCEPT when the assistant
   * model changes, which clears it (see `upsertTeamAiSettings`).
   */
  assistantReasoningLevel: reasoningLevelSchema.nullish(),
});

/**
 * Reject an override the team may not pick — the authorisation counterpart to
 * the display list above, which deliberately returns disabled models too.
 * Unknown key, or one this function measurably cannot use, 400 here.
 */
const assertSelectableForFunction = (
  key: string | null | undefined,
  fn: ModelFunctionKey,
): void => {
  if (key === undefined || key === null) return;
  // The EFFECTIVE registry: the display list offers promoted models, so the
  // authorisation check has to recognise the same set the picker showed.
  const profile = getEffectiveProfile(key);
  if (!profile) {
    throwHttpError(400, badRequest(`"${key}" is not a known model`));
    return;
  }
  if (!selectableForFunction(profile, fn)) {
    throwHttpError(
      400,
      badRequest(
        profile.assessment.enabled
          ? `"${key}" cannot serve ${fn}`
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

  const { assistantReasoningLevel } = parsed.data;

  const requested: Partial<Record<ModelFunctionKey, string | null>> = {};
  for (const [fn, key] of Object.entries(parsed.data.functions ?? {})) {
    if (!isModelFunctionKey(fn)) {
      return throwHttpError(400, badRequest(`"${fn}" is not a model function`));
    }
    requested[fn] = key ?? null;
  }
  for (const [fn, key] of Object.entries(requested)) {
    if (isModelFunctionKey(fn)) assertSelectableForFunction(key, fn);
  }

  // A depth is only meaningful against a model. Validate it against the model
  // this request LEAVES in effect — the one being set here, or the one already
  // stored — so "high" can never be pinned onto a model whose ladder lacks it.
  if (assistantReasoningLevel) {
    const stored = await getTeamAiSettings(team.id);
    const targetKey =
      requested.assistant ??
      functionProfileKey(stored, "assistant") ??
      recommendedProfileKeyForFunction("assistant");
    const target = getEffectiveProfile(targetKey);
    if (
      !target ||
      !selectableReasoningLevels(target).some(
        (level) => level === assistantReasoningLevel,
      )
    ) {
      return throwHttpError(
        400,
        badRequest(
          `"${assistantReasoningLevel}" is not a thinking depth "${targetKey}" supports`,
        ),
      );
    }
  }

  const settings = await upsertTeamAiSettings({
    teamId: team.id,
    functionProfileKeys: requested,
    assistantReasoningLevel,
  });

  return c.json({
    functions: settings.functionProfileKeys,
    // Returned because the caller cannot predict it: switching model clears it.
    assistantReasoningLevel: settings.assistantReasoningLevel,
  });
});

export { modelProfilesRoutes };
