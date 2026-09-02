import { eq } from "drizzle-orm";
import db from "../../db";
import { modelAlerts, modelLiveState } from "../../db/schema/model-registry";
import {
  PROMOTION_PRICE_CAPS,
  promotionEnablement,
} from "../../model-registry/policy";
import {
  normalizeProviderList,
  normalizeProviderName,
} from "../../model-registry/provider-names";
import {
  IMPLEMENTED_TRANSPORTS,
  isTransportId,
  type AcknowledgeAlertOutcome,
  type BulkFailure,
  type DisabledReason,
  type DynamicProfile,
  type ExcludeProviderOutcome,
  type IncludeProviderOutcome,
  type PricingSnapshot,
  type PromoteOutcome,
  type RetireOutcome,
  type SetEnabledOutcome,
  type SetTransportOutcome,
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
 * only ever driven by a person, and that is why the GUARDS BELONG HERE rather
 * than in a caller: there is no automated path to break by refusing, and a
 * guard living in one surface's presentation layer protects only that surface.
 * `retireModel` was the proof — the CLI refused to retire a model an internal
 * role runs on, the service happily did it, and anything else calling the
 * service could have taken the chatbot down.
 *
 * Every function reports an OUTCOME instead of throwing prose. Two surfaces
 * consume these and only one prints English.
 */

/**
 * Move a model to another transport. THE rollback: one call takes a model off
 * the Gateway and back onto OpenRouter, or the reverse, with its pool for that
 * transport already stored on the row.
 */
export const setTransport = async (
  profileKey: string,
  transport: TransportId,
): Promise<SetTransportOutcome> => {
  // The one throw kept in this file: `custom` is a declared `TransportId` with
  // no adapter, so reaching this means a caller offered a transport the build
  // cannot serve. That is a bug, not an operator's situation.
  if (!IMPLEMENTED_TRANSPORTS.includes(transport)) {
    throw new Error(
      `Transport "${transport}" has no adapter — implemented: ${IMPLEMENTED_TRANSPORTS.join(", ")}`,
    );
  }
  const state = await readLiveStateRow(profileKey);
  if (!state) return { kind: "unknown-model" };
  if (state.modelIds[transport] === undefined) {
    return {
      kind: "no-model-id",
      transport,
      available: Object.keys(state.modelIds).filter(isTransportId),
    };
  }
  if (state.transport === transport) {
    return { kind: "already-on-transport", transport };
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
  return { kind: "switched", from: state.transport, to: transport };
};

/**
 * Take a host out of one model's pool, durably, for a reason no probe settles.
 *
 * Writes `providerPool[transport].ignore` — the judgment half of a pool, the
 * one the sync carries across passes rather than recomputing. It takes effect
 * on the next model construction, because both transports read the row's
 * `ignore` and send it on the wire; the sync then drops the host from `only` on
 * its next pass.
 *
 * Not a quarantine, and the difference is the point: a quarantine expires in
 * seven days and is released when the host passes its re-probe, which is right
 * for "this host truncated an answer" and wrong for "this host is not worth its
 * price" — the probe would pass and silently undo the decision.
 *
 * Excluding the LAST member is allowed. The pool then empties and the breaker's
 * widening takes over, which is a consequence to report, not a reason to refuse
 * a deliberate act.
 */
export const setProviderExcluded = async (
  profileKey: string,
  provider: string,
  transport: TransportId,
): Promise<ExcludeProviderOutcome> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) return { kind: "unknown-model" };
  const name = normalizeProviderName(provider);
  const pool = state.providerPool[transport] ?? {};
  const ignore = normalizeProviderList(pool.ignore ?? []);
  if (ignore.includes(name)) {
    return { kind: "already-excluded", provider: name, transport };
  }
  const only = normalizeProviderList(pool.only ?? []).filter(
    (member) => member !== name,
  );
  await db
    .update(modelLiveState)
    .set({
      providerPool: {
        ...state.providerPool,
        [transport]: {
          ...pool,
          ignore: [...ignore, name],
          ...(pool.only === undefined ? {} : { only }),
        },
      },
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
  return {
    kind: "excluded",
    provider: name,
    transport,
    remaining: only.length,
  };
};

/** Undo an exclusion. The host returns to the pool on the next sync pass. */
export const setProviderIncluded = async (
  profileKey: string,
  provider: string,
  transport: TransportId,
): Promise<IncludeProviderOutcome> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) return { kind: "unknown-model" };
  const name = normalizeProviderName(provider);
  const pool = state.providerPool[transport] ?? {};
  const ignore = normalizeProviderList(pool.ignore ?? []);
  if (!ignore.includes(name)) {
    return { kind: "not-excluded", provider: name, transport };
  }
  const kept = ignore.filter((member) => member !== name);
  await db
    .update(modelLiveState)
    .set({
      providerPool: {
        ...state.providerPool,
        // An empty `ignore` is dropped rather than stored as `[]`: the row
        // should read "no judgment recorded", not "a judgment about nobody".
        [transport]:
          kept.length === 0
            ? { ...pool, ignore: undefined }
            : { ...pool, ignore: kept },
      },
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  await invalidateLiveRegistry();
  return { kind: "included", provider: name, transport };
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
): Promise<SetEnabledOutcome> => {
  const outcome = await setEnabledOne(profileKey, enabled, disabledReason);
  if (outcome.kind === "updated") await invalidateLiveRegistry();
  return outcome;
};

/**
 * Enable or disable several models with ONE cache drop.
 *
 * Same economy as `promoteCandidates`, and the same reason: the drop makes
 * every replica rebuild its memoised models, so twenty clicks in three seconds
 * would be twenty fleet-wide rebuilds during live traffic.
 */
export const setEnabledMany = async (
  profileKeys: string[],
  enabled: boolean,
  disabledReason?: DisabledReason,
): Promise<
  { profileKey: string; outcome: SetEnabledOutcome | BulkFailure }[]
> => {
  const results = await runBatch(profileKeys, (profileKey) =>
    setEnabledOne(profileKey, enabled, disabledReason),
  );
  if (results.some((result) => result.outcome.kind === "updated")) {
    await invalidateLiveRegistry();
  }
  return results;
};

/**
 * One enable/disable, WITHOUT the cache drop.
 *
 * @internal — see `promoteOne` for why the invalidation belongs to the
 * operation rather than to the row write.
 */
const setEnabledOne = async (
  profileKey: string,
  enabled: boolean,
  disabledReason?: DisabledReason,
): Promise<SetEnabledOutcome> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) return { kind: "unknown-model" };
  const reason = enabled ? null : (disabledReason ?? "unavailable");
  await db
    .update(modelLiveState)
    .set({
      enabled,
      disabledReason: reason,
      // A deliberate re-enable clears the streak, so an operator who fixed the
      // underlying problem is not disabled again by yesterday's count.
      policyFailStreak: enabled ? 0 : undefined,
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
  return {
    kind: "updated",
    enabled,
    disabledReason: reason,
    boundRoles: state.boundRoles,
  };
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
): Promise<PromoteOutcome> => {
  const outcome = await promoteOne(profileKey);
  if (outcome.kind === "promoted") await invalidateLiveRegistry();
  return outcome;
};

/**
 * Promote several candidates with ONE cache drop.
 *
 * `invalidateLiveRegistry` publishes on Redis and makes every replica rebuild
 * the models memoised from the old snapshot. Twenty promotions clicked in
 * three seconds would be twenty rebuilds during live traffic — the largest
 * operational risk a clickable surface adds to this engine — so the batch
 * writes each row and drops the snapshot once at the end.
 *
 * Sequential, not `Promise.all`: each promotion is a read-then-write with no
 * lock, and parallelism buys nothing measurable on single-row updates while
 * making the alert order nondeterministic.
 *
 * NOT transactional, and it must not pretend to be — see `promoteModels` in
 * `operations.ts` for why per-key verdicts beat all-or-nothing here.
 */
export const promoteCandidates = async (
  profileKeys: string[],
): Promise<{ profileKey: string; outcome: PromoteOutcome | BulkFailure }[]> => {
  const results = await runBatch(profileKeys, promoteOne);
  if (results.some((result) => result.outcome.kind === "promoted")) {
    await invalidateLiveRegistry();
  }
  return results;
};

/**
 * Run one write per key, in order, surviving a key that throws.
 *
 * SEQUENTIAL, not `Promise.all`: each write is a read-then-write with no lock,
 * and parallelism buys nothing measurable on single-row updates while making
 * the order of the alerts they raise nondeterministic.
 *
 * A key that throws becomes a `failed` entry and the batch continues. Letting
 * the exception out would abandon the keys already written — including their
 * cache invalidation — and tell the operator nothing about where the batch
 * stopped, which is worse than either extreme.
 */
const runBatch = async <TOutcome>(
  profileKeys: string[],
  write: (profileKey: string) => Promise<TOutcome>,
): Promise<{ profileKey: string; outcome: TOutcome | BulkFailure }[]> => {
  const results: { profileKey: string; outcome: TOutcome | BulkFailure }[] = [];
  for (const profileKey of profileKeys) {
    try {
      results.push({ profileKey, outcome: await write(profileKey) });
    } catch (err: unknown) {
      console.error(
        `[model-admin] batch write failed on "${profileKey}":`,
        err instanceof Error ? err.message : err,
      );
      results.push({
        profileKey,
        outcome: {
          kind: "failed",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  return results;
};

/**
 * One promotion, WITHOUT the cache drop.
 *
 * @internal — the invalidation is a property of the operation, not of the row
 * write, so only the two exported wrappers above decide when it happens.
 */
const promoteOne = async (profileKey: string): Promise<PromoteOutcome> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) return { kind: "unknown-model" };
  const budget = promotionEnablement(state.pricing);
  const verdict = {
    enabled: budget.enabled,
    disabledReason: budget.disabledReason ?? null,
  };
  if (state.status === "published") {
    return { kind: "already-published", ...verdict };
  }
  await db
    .update(modelLiveState)
    .set({
      status: "published",
      ...verdict,
      source: "admin",
    })
    .where(eq(modelLiveState.profileKey, profileKey));
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
  return {
    kind: "promoted",
    ...verdict,
    pricing: state.pricing,
    catalogueDerivedOnly: state.dynamicProfile !== null,
  };
};

/**
 * Take a model out of every picker without deleting its history.
 *
 * REFUSES on a model an internal role runs on. That guard used to live in the
 * CLI while this function updated unconditionally, so the protection covered
 * one surface and nothing else — and what it protects against is the chatbot
 * losing its model, not a team losing a preference.
 */
export const retireModel = async (
  profileKey: string,
): Promise<RetireOutcome> => {
  const state = await readLiveStateRow(profileKey);
  if (!state) return { kind: "unknown-model" };
  if (state.boundRoles.length > 0) {
    return { kind: "refused-bound-roles", roles: state.boundRoles };
  }
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
  return { kind: "retired", previousStatus: state.status };
};

/*
 * `setProviderPool` was here and is deleted (2026-09-01). It had no caller
 * anywhere — not the CLI, not the HTTP handler, not the front end — and it was
 * not a harmless spare: it set `poolWidened: false` alongside the write, so
 * wiring it up would have silently cancelled a breaker widening and re-applied
 * an `only` list the breaker had just been forced to abandon.
 *
 * Nothing is lost. The vetted pool is DERIVED and rewritten every night by the
 * sync from the endpoints that pass policy, ordered by throughput, carrying
 * `ignore` forward. That is the automatic half working as intended; the manual
 * half an operator actually needs is quarantine and release, which go through
 * the breaker and keep their audit trail.
 */

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

/**
 * Acknowledge an alert so the digest stops carrying it.
 *
 * Checks the alert exists. The bare `UPDATE` it replaced matched no row on a
 * bogus id and still reported success, so a mistyped id was indistinguishable
 * from a real acknowledgement.
 */
export const acknowledgeAlert = async (
  id: string,
): Promise<AcknowledgeAlertOutcome> => {
  const [existing] = await db
    .select({ kind: modelAlerts.kind, modelKey: modelAlerts.modelKey })
    .from(modelAlerts)
    .where(eq(modelAlerts.id, id))
    .limit(1);
  if (existing === undefined) return { kind: "unknown-alert" };
  await db
    .update(modelAlerts)
    .set({ acknowledgedAt: new Date() })
    .where(eq(modelAlerts.id, id));
  return {
    kind: "acknowledged",
    alertKind: existing.kind,
    modelKey: existing.modelKey,
  };
};
