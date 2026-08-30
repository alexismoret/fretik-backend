import { eq } from "drizzle-orm";
import db from "../../db";
import { modelAlerts, modelLiveState } from "../../db/schema/model-registry";
import {
  PROMOTION_PRICE_CAPS,
  promotionEnablement,
} from "../../model-registry/policy";
import {
  IMPLEMENTED_TRANSPORTS,
  type DisabledReason,
  type DynamicProfile,
  type PricingSnapshot,
  type ProviderPoolByTransport,
  type TransportId,
} from "../../model-registry/types";
import { raiseModelAlert } from "./alerts";
import { invalidateLiveRegistry, readLiveStateRow } from "./live";

/**
 * Deliberate operator actions on live state. Everything here takes effect on
 * the next model construction anywhere in the fleet — no deploy, no restart —
 * which is the property that makes the whole engine worth building.
 *
 * The automatic paths (sync, breaker) live in their own modules. This one is
 * only ever driven by a person through `model-admin`.
 */

/**
 * Move a model to another transport. THE rollback: one call takes a model off
 * the Gateway and back onto OpenRouter, or the reverse, with its pool for that
 * transport already stored on the row.
 */
export const setTransport = async (
  profileKey: string,
  transport: TransportId,
): Promise<void> => {
  if (!IMPLEMENTED_TRANSPORTS.includes(transport)) {
    throw new Error(
      `Transport "${transport}" has no adapter — implemented: ${IMPLEMENTED_TRANSPORTS.join(", ")}`,
    );
  }
  const state = await readLiveStateRow(profileKey);
  if (!state) throw new Error(`Unknown model "${profileKey}"`);
  if (state.modelIds[transport] === undefined) {
    throw new Error(
      `"${profileKey}" has no model id for transport "${transport}" — add one to its profile first`,
    );
  }
  await db
    .update(modelLiveState)
    // A transport switch starts from a clean routing slate: the previous
    // transport's widening and last-resort state described a different set of
    // hosts entirely. Quarantines are kept — they are recorded per transport.
    .set({
      transport,
      poolWidened: false,
      lastResort: false,
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
};

/**
 * Enable or disable a model for teams. Disabling never breaks a running turn:
 * a team whose selection becomes unselectable degrades to the code default at
 * resolution time, which is a path that already existed for unknown keys.
 */
export const setEnabled = async (
  profileKey: string,
  enabled: boolean,
  disabledReason?: DisabledReason,
): Promise<void> => {
  await db
    .update(modelLiveState)
    .set({
      enabled,
      disabledReason: enabled ? null : (disabledReason ?? "unavailable"),
      // A deliberate re-enable clears the streak, so an operator who fixed the
      // underlying problem is not disabled again by yesterday's count.
      policyFailStreak: enabled ? 0 : undefined,
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
};

/**
 * Publish a candidate. Discovery is automatic and publication is not: day-zero
 * endpoints are measurably unstable — the same model's tool-calling accuracy
 * spans 22 % to 37 % depending on the host — so a person looks at the scorecard
 * before a team can pick the model.
 *
 * Publishing and PAYING are separate decisions since 2026-08-30. Discovery no
 * longer filters on price, so a promoted model may well be dearer than the
 * budget allows: it becomes visible either way, but arrives disabled on cost
 * unless its measured pool price fits. That keeps an expensive model a choice
 * an operator makes on purpose rather than one the catalogue hides.
 */
export const promoteCandidate = async (
  profileKey: string,
): Promise<{ enabled: boolean; disabledReason: "cost" | null }> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) throw new Error(`Unknown model "${profileKey}"`);
  const budget = promotionEnablement(state.pricing);
  const verdict = {
    enabled: budget.enabled,
    disabledReason: budget.disabledReason ?? null,
  };
  if (state.status === "published") return verdict;
  await db
    .update(modelLiveState)
    .set({
      status: "published",
      ...verdict,
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
  await raiseModelAlert({
    kind: "new-candidate",
    severity: "info",
    modelKey: profileKey,
    message: `${profileKey} promoted to published${
      budget.enabled
        ? ""
        : ` but left DISABLED on cost: $${state.pricing.inputPerMTok.toString()}/$${state.pricing.outputPerMTok.toString()} per MTok against a budget of $${PROMOTION_PRICE_CAPS.inputPerMTok.toString()}/$${PROMOTION_PRICE_CAPS.outputPerMTok.toString()}`
    }${state.dynamicProfile ? " (catalogue-derived profile — no TypeScript profile yet)" : ""}.`,
  });
  return verdict;
};

/** Take a model out of every picker without deleting its history. */
export const retireModel = async (profileKey: string): Promise<void> => {
  await db
    .update(modelLiveState)
    .set({
      status: "retired",
      enabled: false,
      disabledReason: "unavailable",
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
};

/** Replace a model's vetted pool for one transport. */
export const setProviderPool = async (
  profileKey: string,
  transport: TransportId,
  pool: ProviderPoolByTransport[TransportId],
): Promise<void> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) throw new Error(`Unknown model "${profileKey}"`);
  await db
    .update(modelLiveState)
    .set({
      providerPool: { ...state.providerPool, [transport]: pool },
      // A pool the operator just widened by hand is no longer "widened by the
      // breaker because the vetted list ran out".
      poolWidened: false,
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
};

/**
 * Add a model straight from the catalogue, with a profile derived from its
 * catalogue facts so it is usable without a deploy. Inserted as a candidate:
 * `model-admin promote` is the second, deliberate step.
 */
export const addCatalogueModel = async (input: {
  profileKey: string;
  transport: TransportId;
  modelIds: Partial<Record<TransportId, string>>;
  dynamicProfile: DynamicProfile;
  effectiveContextLength: number;
  effectiveMaxOutput?: number;
  pricing: PricingSnapshot;
}): Promise<void> => {
  await db
    .insert(modelLiveState)
    .values({
      profileKey: input.profileKey,
      status: "candidate",
      transport: input.transport,
      enabled: false,
      modelIds: input.modelIds,
      providerPool: {},
      effectiveContextLength: input.effectiveContextLength,
      effectiveMaxOutput: input.effectiveMaxOutput ?? null,
      pricing: input.pricing,
      dynamicProfile: input.dynamicProfile,
      boundRoles: [],
      source: "admin",
    })
    .onConflictDoNothing({ target: modelLiveState.profileKey });
  await invalidateLiveRegistry();
};

/** Acknowledge an alert so the digest stops carrying it. */
export const acknowledgeAlert = async (id: string): Promise<void> => {
  await db
    .update(modelAlerts)
    .set({ acknowledgedAt: new Date() })
    .where(eq(modelAlerts.id, id));
};
