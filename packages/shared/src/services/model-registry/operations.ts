import db from "../../db";
import { modelAdminActions } from "../../db/schema/model-registry";
import {
  PROMOTION_PRICE_CAPS,
  promotionEnablement,
} from "../../model-registry/policy";
import type {
  AcknowledgeAlertOutcome,
  AddFromCatalogueOutcome,
  BulkFailure,
  Consequence,
  DisabledReason,
  ExcludeProviderOutcome,
  IncidentKind,
  IncludeProviderOutcome,
  LiveModelState,
  ModelStateSummary,
  ModelWriteActor,
  PromoteOutcome,
  QuarantineOutcome,
  ReleaseOutcome,
  RetireOutcome,
  SetEnabledOutcome,
  SetTransportOutcome,
  TransportId,
} from "../../model-registry/types";
import { addFromCatalogue } from "./add-from-catalogue";
import {
  acknowledgeAlert,
  promoteCandidate,
  promoteCandidates,
  retireModel,
  setEnabled,
  setEnabledMany,
  setProviderExcluded,
  setProviderIncluded,
  setTransport,
} from "./admin";
import {
  BREAKER_THRESHOLDS,
  activeQuarantines,
  quarantineProvider,
  releaseProvider,
} from "./breaker";
import { readLiveStateRow } from "./live";

/**
 * One operator action, from decision to record.
 *
 * The services below decide; this layer composes what a SURFACE needs around
 * that decision — the row before, the row after, what the change means, and a
 * line in the action log naming who did it. Both the CLI and the HTTP handler
 * go through here, so neither can drift from the other on any of the four.
 *
 * What it deliberately does NOT own: the refusals. Those live in the services
 * (`admin.ts`, `breaker.ts`) so a future caller that skips this module still
 * cannot retire a model an internal role runs on. A guard in a composition
 * layer protects only the callers that remember to use it — which is the exact
 * defect this whole chantier started from.
 *
 * Nor does it own cache invalidation. The plan had it lifted up here so a bulk
 * write could drop the fleet's cache once instead of N times, but a leaf that
 * no longer invalidates is a fleet-wide silent failure the moment anything
 * calls it directly. The leaves keep invalidating; `promoteCandidates` gets
 * the same economy by batching inside `admin.ts`, where the invariant is local
 * and provable.
 */

/** The narrow row shape a write reports, before and after. */
export const summarise = (
  state: LiveModelState,
  now: Date,
): ModelStateSummary => ({
  profileKey: state.profileKey,
  status: state.status,
  transport: state.transport,
  enabled: state.enabled,
  disabledReason: state.disabledReason,
  health: state.health,
  poolWidened: state.poolWidened,
  lastResort: state.lastResort,
  activeQuarantineCount: activeQuarantines(state, now).length,
  boundRoles: state.boundRoles,
});

/**
 * What every operation answers with.
 *
 * `after` is undefined only when nothing was written — a refusal, or a no-op.
 * Callers should render `outcome` first and treat the summaries as context:
 * the outcome is the decision, the rows are evidence for it.
 */
export interface OperationResult<TOutcome> {
  outcome: TOutcome;
  before?: ModelStateSummary;
  after?: ModelStateSummary;
  consequences: Consequence[];
}

/**
 * Record the action, whatever it was.
 *
 * Refusals included, on purpose: "someone tried to retire the chatbot's model
 * and was stopped" is precisely the line worth finding weeks later, and it is
 * the one a success-only log would not have.
 *
 * Never throws. A failure to journal must not undo or mask a write that has
 * already landed — the operator would see an error for something that did in
 * fact happen, which is worse than an unlogged action.
 */
const record = async (input: {
  actor: ModelWriteActor;
  action: string;
  profileKey: string | null;
  outcome: string;
  payload: Record<string, unknown>;
}): Promise<void> => {
  try {
    await db.insert(modelAdminActions).values({
      userId: input.actor.kind === "operator" ? input.actor.userId : null,
      action: input.action,
      profileKey: input.profileKey,
      outcome: input.outcome,
      payload: input.payload,
    });
  } catch (err: unknown) {
    console.error(
      "[model-admin] failed to record action:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** The shared shape of every call into this module. */
interface OperationInput {
  actor: ModelWriteActor;
  now?: Date;
}

/**
 * Read → act → re-read → record.
 *
 * `after` comes from a fresh read rather than from what the service says it
 * wrote: a projection agrees with itself by construction, so it can only
 * confirm the code's intention, never the database's state.
 */
const perform = async <TOutcome extends { kind: string }>(input: {
  actor: ModelWriteActor;
  now: Date;
  action: string;
  profileKey: string | null;
  run: (before: LiveModelState | undefined) => Promise<{
    outcome: TOutcome;
    consequences: Consequence[];
    wrote: boolean;
  }>;
  extraPayload?: Record<string, unknown>;
}): Promise<OperationResult<TOutcome>> => {
  const beforeRow =
    input.profileKey === null
      ? undefined
      : await readLiveStateRow(input.profileKey);
  const before =
    beforeRow === undefined ? undefined : summarise(beforeRow, input.now);

  const { outcome, consequences, wrote } = await input.run(beforeRow);

  const afterRow =
    wrote && input.profileKey !== null
      ? await readLiveStateRow(input.profileKey)
      : undefined;
  const after =
    afterRow === undefined ? undefined : summarise(afterRow, input.now);

  await record({
    actor: input.actor,
    action: input.action,
    profileKey: input.profileKey,
    outcome: outcome.kind,
    payload: {
      ...input.extraPayload,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      consequences,
    },
  });

  return {
    outcome,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    consequences,
  };
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const promoteModel = async (
  input: OperationInput & { profileKey: string },
): Promise<OperationResult<PromoteOutcome>> =>
  perform<PromoteOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "promote",
    profileKey: input.profileKey,
    run: async () => {
      const outcome = await promoteCandidate(input.profileKey);
      return {
        outcome,
        consequences:
          outcome.kind === "promoted" ? promotionConsequences(outcome) : [],
        wrote: outcome.kind === "promoted",
      };
    },
  });

/** Shared by the single promote and the bulk one, so they cannot disagree. */
const promotionConsequences = (outcome: {
  enabled: boolean;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  catalogueDerivedOnly: boolean;
}): Consequence[] => {
  const consequences: Consequence[] = [];
  if (!outcome.enabled) {
    consequences.push({
      code: "published-disabled-on-cost",
      inputPerMTok: outcome.pricing.inputPerMTok,
      outputPerMTok: outcome.pricing.outputPerMTok,
      capInputPerMTok: PROMOTION_PRICE_CAPS.inputPerMTok,
      capOutputPerMTok: PROMOTION_PRICE_CAPS.outputPerMTok,
    });
  }
  if (outcome.catalogueDerivedOnly) {
    consequences.push({ code: "catalogue-derived-profile-only" });
  }
  return consequences;
};

export const retireModelOperation = async (
  input: OperationInput & { profileKey: string },
): Promise<OperationResult<RetireOutcome>> =>
  perform<RetireOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "retire",
    profileKey: input.profileKey,
    run: async () => {
      const outcome = await retireModel(input.profileKey);
      return { outcome, consequences: [], wrote: outcome.kind === "retired" };
    },
  });

export const setModelEnabled = async (
  input: OperationInput & {
    profileKey: string;
    enabled: boolean;
    reason?: DisabledReason;
  },
): Promise<OperationResult<SetEnabledOutcome>> =>
  perform<SetEnabledOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: input.enabled ? "enable" : "disable",
    profileKey: input.profileKey,
    run: async (before) => {
      const outcome = await setEnabled(
        input.profileKey,
        input.enabled,
        input.reason,
      );
      if (outcome.kind !== "updated") {
        return { outcome, consequences: [], wrote: false };
      }
      const consequences: Consequence[] = [];
      if (input.enabled && before?.enabled === true) {
        consequences.push({ code: "was-already-enabled" });
      }
      if (
        input.enabled &&
        before !== undefined &&
        before.status !== "published"
      ) {
        consequences.push({ code: "still-unpublished", status: before.status });
      }
      // Asymmetric with `retire`, which refuses outright: disabling leaves the
      // roles running, because they resolve their profile directly.
      if (!input.enabled && outcome.boundRoles.length > 0) {
        consequences.push({
          code: "roles-bypass-enabled",
          roles: outcome.boundRoles,
        });
      }
      return { outcome, consequences, wrote: true };
    },
  });

export const switchModelTransport = async (
  input: OperationInput & { profileKey: string; transport: TransportId },
): Promise<OperationResult<SetTransportOutcome>> =>
  perform<SetTransportOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "set-transport",
    profileKey: input.profileKey,
    extraPayload: { transport: input.transport },
    run: async (before) => {
      const outcome = await setTransport(input.profileKey, input.transport);
      if (outcome.kind !== "switched") {
        return { outcome, consequences: [], wrote: false };
      }
      const kept =
        before === undefined
          ? 0
          : activeQuarantines(before, input.now ?? new Date()).length;
      return {
        outcome,
        consequences:
          kept > 0 ? [{ code: "quarantines-kept-per-transport", kept }] : [],
        wrote: true,
      };
    },
  });

export const quarantineUpstream = async (
  input: OperationInput & {
    profileKey: string;
    provider: string;
    transport: TransportId;
    kind: IncidentKind;
    reason: string;
  },
): Promise<OperationResult<QuarantineOutcome>> => {
  const now = input.now ?? new Date();
  return perform<QuarantineOutcome>({
    actor: input.actor,
    now,
    action: "quarantine",
    profileKey: input.profileKey,
    extraPayload: { provider: input.provider, incidentKind: input.kind },
    run: async () => {
      const outcome = await quarantineProvider({
        modelKey: input.profileKey,
        provider: input.provider,
        transport: input.transport,
        kind: input.kind,
        reason: input.reason,
        actor: input.actor,
        now,
      });
      const threshold = BREAKER_THRESHOLDS[input.kind];
      const consequences: Consequence[] = [];
      if (outcome.kind === "pool-widened") {
        consequences.push({
          code: "pool-widened",
          remaining: outcome.remaining,
        });
      }
      if (outcome.kind === "transport-switched") {
        consequences.push({
          code: "transport-switched",
          from: outcome.from,
          to: outcome.to,
        });
      }
      if (outcome.kind === "last-resort") {
        consequences.push({ code: "now-last-resort" });
      }
      if (
        outcome.kind === "quarantined" ||
        outcome.kind === "pool-widened" ||
        outcome.kind === "transport-switched"
      ) {
        consequences.push({
          code: "release-is-review-trigger",
          releaseAt: outcome.entry.releaseAt,
        });
        consequences.push({
          code: "breaker-would-need",
          kind: input.kind,
          generations: threshold.generations,
          windowMinutes: threshold.windowMinutes,
        });
      }
      return {
        outcome,
        consequences,
        wrote:
          outcome.kind !== "already-quarantined" &&
          outcome.kind !== "no-live-row",
      };
    },
  });
};

/**
 * Exclude a host from one model's pool, durably.
 *
 * The sibling of `quarantineUpstream` for the reasons a probe cannot settle —
 * price, an unfavourable rate limit, a commercial decision. Logged under its
 * own action so the journal distinguishes "the breaker's ladder was pulled by
 * hand" from "somebody made a judgment call".
 */
export const excludeUpstream = async (
  input: OperationInput & {
    profileKey: string;
    provider: string;
    transport: TransportId;
    reason: string;
  },
): Promise<OperationResult<ExcludeProviderOutcome>> =>
  perform<ExcludeProviderOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "exclude",
    profileKey: input.profileKey,
    extraPayload: { provider: input.provider, reason: input.reason },
    run: async () => {
      const outcome = await setProviderExcluded(
        input.profileKey,
        input.provider,
        input.transport,
      );
      const consequences: Consequence[] =
        outcome.kind === "excluded"
          ? [
              { code: "exclusion-is-durable" },
              ...(outcome.remaining === 0
                ? [{ code: "pool-emptied" as const }]
                : []),
            ]
          : [];
      return { outcome, consequences, wrote: outcome.kind === "excluded" };
    },
  });

/** Undo an exclusion. The host returns to the pool on the next sync pass. */
export const includeUpstream = async (
  input: OperationInput & {
    profileKey: string;
    provider: string;
    transport: TransportId;
  },
): Promise<OperationResult<IncludeProviderOutcome>> =>
  perform<IncludeProviderOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "include",
    profileKey: input.profileKey,
    extraPayload: { provider: input.provider },
    run: async () => {
      const outcome = await setProviderIncluded(
        input.profileKey,
        input.provider,
        input.transport,
      );
      return {
        outcome,
        consequences:
          outcome.kind === "included"
            ? [{ code: "returns-on-next-sync" as const }]
            : [],
        wrote: outcome.kind === "included",
      };
    },
  });

export const releaseUpstream = async (
  input: OperationInput & {
    profileKey: string;
    provider: string;
    transport: TransportId;
    reason: string;
  },
): Promise<OperationResult<ReleaseOutcome>> =>
  perform<ReleaseOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "release",
    profileKey: input.profileKey,
    extraPayload: { provider: input.provider },
    run: async () => {
      const outcome = await releaseProvider({
        modelKey: input.profileKey,
        provider: input.provider,
        transport: input.transport,
        reason: input.reason,
        actor: input.actor,
      });
      if (outcome.kind !== "released") {
        return { outcome, consequences: [], wrote: false };
      }
      const consequences: Consequence[] = [];
      if (outcome.poolRenarrowed)
        consequences.push({ code: "pool-renarrowed" });
      if (outcome.lastResortLifted) {
        consequences.push({ code: "last-resort-lifted" });
      }
      return { outcome, consequences, wrote: true };
    },
  });

export const acknowledgeModelAlert = async (
  input: OperationInput & { alertId: string },
): Promise<OperationResult<AcknowledgeAlertOutcome>> =>
  perform<AcknowledgeAlertOutcome>({
    actor: input.actor,
    now: input.now ?? new Date(),
    action: "ack-alert",
    // Not a model action: an alert can carry no model key at all.
    profileKey: null,
    extraPayload: { alertId: input.alertId },
    run: async () => {
      const outcome = await acknowledgeAlert(input.alertId);
      return { outcome, consequences: [], wrote: false };
    },
  });

/**
 * Add a model from the catalogue, and record that someone did.
 *
 * Not routed through `perform`, which reads the row BEFORE acting: `add` has no
 * profile key until the catalogue answers, so there is nothing to read and no
 * `before` to report. What it does share is the part that matters — every
 * operator write leaves a line, refusals included, so "who added this model,
 * and when" is answerable three weeks later.
 */
export const addModelFromCatalogue = async (
  input: OperationInput & { modelId: string; profileKey?: string },
): Promise<AddFromCatalogueOutcome> => {
  const outcome = await addFromCatalogue({
    modelId: input.modelId,
    ...(input.profileKey === undefined ? {} : { profileKey: input.profileKey }),
    now: input.now ?? new Date(),
  });
  await record({
    actor: input.actor,
    action: "add",
    profileKey:
      outcome.kind === "added" ||
      outcome.kind === "key-exists" ||
      outcome.kind === "insert-lost-race"
        ? outcome.profileKey
        : null,
    outcome: outcome.kind,
    payload: { modelId: input.modelId },
  });
  return outcome;
};

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

/**
 * One key's verdict inside a batch. Never an all-or-nothing envelope.
 *
 * These loop a single-row service rather than issuing one set-based statement,
 * against this package's usual bulk rule and for a reason the rule itself
 * anticipates: each key needs its own row read before the decision (promotion
 * enablement is computed from that row's pricing) and raises its own alert, so
 * there is nothing to express as a single `UPDATE … FROM (VALUES …)`. The
 * batch is capped at the request boundary, and the pairing is exactly the
 * single-row-plus-`bulk*`-sibling shape the rule prescribes: throw-on-first for
 * one key, per-key partial success for many.
 */
export interface BulkPromoteEntry {
  profileKey: string;
  outcome: PromoteOutcome | BulkFailure;
  consequences: Consequence[];
}

/**
 * Promote several candidates, reporting each one separately.
 *
 * NOT transactional, deliberately. The failure modes are per key — unknown
 * key, already published — and all-or-nothing would discard nineteen sound
 * decisions because the twentieth was mistyped. Every entry is an independent
 * published fact with its own alert, and the caller is told exactly which
 * landed.
 *
 * The economy that matters is the cache: `promoteCandidates` writes N rows and
 * drops the fleet's registry snapshot ONCE, because that drop makes every
 * replica rebuild its memoised models. Twenty separate promotions would be
 * twenty rebuilds during live traffic, which is the largest operational risk a
 * clickable surface adds to this engine.
 */
export const promoteModels = async (
  input: OperationInput & { profileKeys: string[] },
): Promise<BulkPromoteEntry[]> => {
  const results = await promoteCandidates(input.profileKeys);

  const entries = results.map((result) => ({
    profileKey: result.profileKey,
    outcome: result.outcome,
    consequences:
      result.outcome.kind === "promoted"
        ? promotionConsequences(result.outcome)
        : [],
  }));

  await Promise.all(
    entries.map((entry) =>
      record({
        actor: input.actor,
        action: "promote",
        profileKey: entry.profileKey,
        outcome: entry.outcome.kind,
        payload: { batch: true, consequences: entry.consequences },
      }),
    ),
  );
  return entries;
};

/** One key's verdict inside an enable/disable batch. */
export interface BulkEnabledEntry {
  profileKey: string;
  outcome: SetEnabledOutcome | BulkFailure;
  consequences: Consequence[];
}

/**
 * Enable or disable several models, reporting each one separately.
 *
 * Same contract as `promoteModels`, and the consequence that matters is the
 * asymmetric one: disabling a model an internal role runs on does NOT stop
 * that role — `enabled` gates team selection, and a bound role resolves its
 * model directly, past the check. That sentence lived in a `console.log` and is
 * the thing an operator most needs before clicking.
 */
export const setModelsEnabled = async (
  input: OperationInput & {
    profileKeys: string[];
    enabled: boolean;
    reason?: DisabledReason;
  },
): Promise<BulkEnabledEntry[]> => {
  const results = await setEnabledMany(
    input.profileKeys,
    input.enabled,
    input.reason,
  );

  const entries = results.map((result): BulkEnabledEntry => {
    const consequences: Consequence[] = [];
    if (
      result.outcome.kind === "updated" &&
      !input.enabled &&
      result.outcome.boundRoles.length > 0
    ) {
      consequences.push({
        code: "roles-bypass-enabled",
        roles: result.outcome.boundRoles,
      });
    }
    return {
      profileKey: result.profileKey,
      outcome: result.outcome,
      consequences,
    };
  });

  await Promise.all(
    entries.map((entry) =>
      record({
        actor: input.actor,
        action: input.enabled ? "enable" : "disable",
        profileKey: entry.profileKey,
        outcome: entry.outcome.kind,
        payload: { batch: true, consequences: entry.consequences },
      }),
    ),
  );
  return entries;
};

/** One alert's verdict inside an acknowledgement batch. */
export interface BulkAckEntry {
  alertId: string;
  outcome: AcknowledgeAlertOutcome | BulkFailure;
}

/**
 * Acknowledge several alerts.
 *
 * No cache to invalidate — an alert is a record of a decision, not part of it —
 * so this is a plain loop over the single operation, which keeps one action-log
 * line per alert. Sequential like the other batches: the acknowledgements are
 * independent, but their action-log order should be the order they were asked
 * for rather than the order the database happened to answer in.
 */
export const acknowledgeModelAlerts = async (
  input: OperationInput & { alertIds: string[] },
): Promise<BulkAckEntry[]> => {
  const entries: BulkAckEntry[] = [];
  for (const alertId of input.alertIds) {
    try {
      const { outcome } = await acknowledgeModelAlert({
        alertId,
        actor: input.actor,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      entries.push({ alertId, outcome });
    } catch (err: unknown) {
      entries.push({
        alertId,
        outcome: {
          kind: "failed",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  return entries;
};

/**
 * What enabling or disabling these keys WOULD do, without writing.
 *
 * The counterpart to `forecastPromotions`, and its useful column is
 * `boundRoles`: the confirmation screen can say "3 of these serve internal
 * roles, and disabling them does not stop those roles" before anyone commits.
 */
export interface EnablementForecast {
  profileKey: string;
  exists: boolean;
  currentStatus: LiveModelState["status"] | "unknown";
  currentlyEnabled: boolean;
  /** True when the request would leave the row exactly as it is. */
  noOp: boolean;
  boundRoles: string[];
}

export const forecastEnablement = async (
  profileKeys: string[],
  enabled: boolean,
): Promise<EnablementForecast[]> =>
  Promise.all(
    profileKeys.map(async (profileKey): Promise<EnablementForecast> => {
      const state = await readLiveStateRow(profileKey);
      if (state === undefined) {
        return {
          profileKey,
          exists: false,
          currentStatus: "unknown",
          currentlyEnabled: false,
          noOp: false,
          boundRoles: [],
        };
      }
      return {
        profileKey,
        exists: true,
        currentStatus: state.status,
        currentlyEnabled: state.enabled,
        noOp: state.enabled === enabled,
        boundRoles: state.boundRoles,
      };
    }),
  );

/**
 * What promoting these keys WOULD do, without writing.
 *
 * Every input to the verdict is already on the row and `promotionEnablement`
 * is pure, so the confirmation screen can name the models that will arrive
 * disabled on cost before anyone commits — which is the outcome that surprises
 * people, and the difference between an operator who understands what happened
 * and one who files a bug.
 */
export interface PromotionForecast {
  profileKey: string;
  currentStatus: LiveModelState["status"] | "unknown";
  willEnable: boolean;
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  catalogueDerivedOnly: boolean;
  boundRoles: string[];
}

export const forecastPromotions = async (
  profileKeys: string[],
): Promise<PromotionForecast[]> =>
  Promise.all(
    profileKeys.map(async (profileKey): Promise<PromotionForecast> => {
      const state = await readLiveStateRow(profileKey);
      if (state === undefined) {
        return {
          profileKey,
          currentStatus: "unknown",
          willEnable: false,
          catalogueDerivedOnly: false,
          boundRoles: [],
        };
      }
      return {
        profileKey,
        currentStatus: state.status,
        willEnable: promotionEnablement(state.pricing).enabled,
        pricing: {
          inputPerMTok: state.pricing.inputPerMTok,
          outputPerMTok: state.pricing.outputPerMTok,
        },
        catalogueDerivedOnly: state.dynamicProfile !== null,
        boundRoles: state.boundRoles,
      };
    }),
  );
