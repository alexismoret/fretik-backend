import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { modelLiveState } from "../../db/schema/model-registry";
import { normalizeProviderName } from "../../model-registry/provider-names";
import {
  IMPLEMENTED_TRANSPORTS,
  sourceForActor,
  type IncidentKind,
  type LiveModelState,
  type ModelStateSource,
  type ModelWriteActor,
  type ProviderPool,
  type QuarantineEntry,
  type QuarantineOutcome,
  type ReleaseOutcome,
  type TransportId,
} from "../../model-registry/types";
import { raiseModelAlert, type RaiseAlertInput } from "./alerts";
import {
  countRecentIncidents,
  recentIncidentIds,
  recordProviderIncident,
  type RecordIncidentInput,
} from "./incidents";
import { invalidateLiveRegistry, readLiveStateRowForUpdate } from "./live";

/**
 * The circuit breaker: it pulls a misbehaving upstream out of a model's pool by
 * itself, within seconds, with no deploy.
 *
 * This is the point of the whole engine. Every provider exclusion used to be a
 * constant in a source file, so an upstream that started corrupting output
 * needed a person to notice, a session to diagnose, a pull request and a
 * release — during which a self-propagating defect kept poisoning conversation
 * history. Two such exclusions also quietly expired and had to be relearned
 * from a second incident.
 *
 * Acting automatically is only safe because of three constraints, and none may
 * be relaxed without new evidence:
 *
 * 1. **Corroboration across generations.** `incidents.ts` files ONE ROW PER
 *    GENERATION, so a threshold of N rows means N separate answers went wrong.
 *    A single pathological response can never trip a quarantine.
 * 2. **A pool that can never be emptied.** See the escalation ladder below.
 * 3. **Definitions with no judgement in them.** The detectors match literal
 *    codepoints and literal tags; nothing here weighs "quality".
 */

interface Threshold {
  /** Distinct generations that must fail inside the window. */
  generations: number;
  windowMinutes: number;
}

/**
 * Thresholds per kind, ordered by how unambiguous the signal is.
 *
 * `forbidden-codepoints` is the strictest and the fastest: a zero-width space
 * next to a digit is never legitimate output, it breaks generated code and
 * spreadsheets outright, and it self-propagates through history — two
 * corroborating generations inside half an hour is enough. The looser kinds are
 * detectable but ambiguous (a turn can legitimately end on "let me check:"
 * before calling a tool), so they need more evidence over a longer window.
 */
const THRESHOLDS: Record<IncidentKind, Threshold> = {
  "forbidden-codepoints": { generations: 2, windowMinutes: 30 },
  "think-leak": { generations: 3, windowMinutes: 60 },
  "truncated-at-tool-call": { generations: 4, windowMinutes: 120 },
  "upstream-cut": { generations: 5, windowMinutes: 120 },
  stall: { generations: 4, windowMinutes: 120 },
};

/**
 * How long an upstream stays out. Long enough that a bad deploy on their side
 * is over, short enough that a pool does not silently shrink forever — and the
 * sync re-probes before letting anyone back in, so the date is a review
 * trigger, not an amnesty.
 */
const QUARANTINE_DAYS = 7;

const HUMAN_KIND: Record<IncidentKind, string> = {
  "forbidden-codepoints": "corrupted emitted text",
  "think-leak": "leaked reasoning tags into the answer",
  "truncated-at-tool-call": "truncated answers at the tool-call boundary",
  "upstream-cut": "cut long generations mid-flight",
  stall: "stopped producing mid-stream",
};

/** Upstreams currently quarantined for a model (expired entries excluded). */
export const activeQuarantines = (
  state: Pick<LiveModelState, "quarantinedProviders">,
  now: Date,
): QuarantineEntry[] =>
  state.quarantinedProviders.filter(
    (entry) => new Date(entry.releaseAt).getTime() > now.getTime(),
  );

const quarantinedNames = (
  state: LiveModelState,
  transport: TransportId,
  now: Date,
): Set<string> =>
  new Set(
    activeQuarantines(state, now)
      .filter((entry) => entry.transport === transport)
      .map((entry) => entry.provider),
  );

/**
 * The pool to send on the wire for this model and transport.
 *
 * `ignore` always carries the quarantines, so a widened (open) pool cannot
 * drift back onto a host the breaker removed. `only` carries the vetted list
 * unless quarantines exhausted it, in which case routing is open — see
 * `poolWidened` on the row for why that beats the alternatives.
 */
export const effectivePoolFor = (
  state: LiveModelState,
  transport: TransportId,
  now: Date,
): ProviderPool => {
  const declared = state.providerPool[transport];
  const quarantined = [...quarantinedNames(state, transport, now)];
  const only = state.poolWidened
    ? undefined
    : declared?.only?.filter((p) => !quarantined.includes(p));
  return {
    ...(only && only.length > 0 ? { only } : {}),
    ...(declared?.order ? { order: declared.order } : {}),
    ignore: [...new Set([...(declared?.ignore ?? []), ...quarantined])],
  };
};

/**
 * Distinct HOSTS the transport still offers once `extraProvider` is pulled.
 *
 * Counted over providers, not over `endpointStats` rows: a row is one route,
 * and one host commonly serves several (Fireworks answers for glm-5.2 under
 * three, xAI for grok-4.5 under two — measured 2026-08-29). The escalation
 * ladder only ever asks whether this is zero, which both counts answer
 * identically, but the alert built from it says "upstream(s) left" — and a
 * route count under that word tells the operator a company is still available
 * when it may be the very one just quarantined.
 */
const cleanEndpointCount = (
  state: LiveModelState,
  transport: TransportId,
  extraProvider: string,
  now: Date,
): number => {
  const excluded = quarantinedNames(state, transport, now);
  excluded.add(extraProvider);
  return new Set(
    state.endpointStats
      .map((e) => e.provider)
      .filter((provider) => !excluded.has(provider)),
  ).size;
};

/** Vetted members left if `provider` went. `undefined` when no vetted pool exists. */
const vettedRemaining = (
  state: LiveModelState,
  transport: TransportId,
  provider: string,
  now: Date,
): number | undefined => {
  if (state.poolWidened) return undefined;
  const only = state.providerPool[transport]?.only;
  if (!only) return undefined;
  const excluded = quarantinedNames(state, transport, now);
  excluded.add(provider);
  return only.filter((p) => !excluded.has(p)).length;
};

/**
 * The live quarantine for this pair, if there is one.
 *
 * Returns the ENTRY rather than a boolean because the caller's next question
 * is always "until when" — the CLI used to recover that by searching the
 * re-read row with `provider.startsWith(provider.slice(0, 4))`, a match loose
 * enough to answer for the wrong host.
 */
const activeQuarantineFor = (
  state: LiveModelState,
  transport: TransportId,
  provider: string,
  now: Date,
): QuarantineEntry | undefined =>
  activeQuarantines(state, now).find(
    (entry) => entry.transport === transport && entry.provider === provider,
  );

/** The transport to try when this one has nothing clean left. */
const alternateTransport = (
  state: LiveModelState,
  current: TransportId,
): TransportId | undefined =>
  IMPLEMENTED_TRANSPORTS.find(
    (candidate) =>
      candidate !== current && state.modelIds[candidate] !== undefined,
  );

/**
 * Quarantine one upstream for one model, escalating rather than ever leaving a
 * model unusable.
 *
 * The ladder, in order, is the answer to "what do we do when the bad host is
 * the last one left" — where the two obvious options are both unacceptable:
 * keeping it means shipping corrupted output to customers, and removing it
 * means every call 404s.
 *
 *   1. Members left in the vetted pool → plain quarantine.
 *   2. Vetted pool exhausted, other endpoints exist on this transport → widen
 *      to open routing minus the quarantined hosts. An unmeasured upstream is a
 *      risk; a measured-bad one is a certainty.
 *   3. Nothing clean on this transport, the model exists on the other one →
 *      switch transport. Entirely different hosts, same model.
 *   4. Nothing anywhere → keep serving on the least-bad endpoint, but set
 *      `lastResort` so roles fall back to their fallback MODEL and teams
 *      degrade to the default. Loud, critical alert.
 *
 * Returns which rung it landed on. NOT a boolean: rung 4 writes the row and
 * would have to report "nothing changed", and the two no-op exits — no row at
 * all, and already quarantined — mean entirely different things to whoever
 * asked.
 */
export const quarantineProvider = async (input: {
  modelKey: string;
  provider: string;
  transport: TransportId;
  kind: IncidentKind;
  reason: string;
  /** Who is asking. Decides the `source` stamp; see `ModelWriteActor`. */
  actor: ModelWriteActor;
  incidentIds?: string[];
  now?: Date;
}): Promise<QuarantineOutcome> => {
  const now = input.now ?? new Date();
  const provider = normalizeProviderName(input.provider);
  const source = sourceForActor(input.actor);

  /**
   * Decide and write under a row lock; alert and invalidate AFTER the commit.
   *
   * `quarantined_providers` is a jsonb array rewritten wholesale, so two
   * writers that both read the old one each write their own entry over the
   * other's and the loser's quarantine disappears with no error anywhere. The
   * alert and the cache drop stay outside because an alert about a write that
   * rolled back is a lie, and invalidating before the commit lets a replica
   * reload exactly the row that is about to change.
   */
  const written = await db.transaction(async (tx): Promise<QuarantineWrite> => {
    const state = await readLiveStateRowForUpdate(tx, input.modelKey);
    if (!state) {
      // No live row means a raw model id from a bypass call site — there is
      // no pool to edit. Record the finding and stop.
      return {
        outcome: { kind: "no-live-row" },
        alert: {
          kind: "quarantine-skipped",
          severity: "warning",
          modelKey: input.modelKey,
          provider,
          message: `${provider} ${HUMAN_KIND[input.kind]} on ${input.modelKey}, which has no live-state row — nothing to quarantine. ${input.reason}`,
        },
        wrote: false,
      };
    }
    const existing = activeQuarantineFor(state, input.transport, provider, now);
    if (existing !== undefined) {
      return {
        outcome: { kind: "already-quarantined", entry: existing },
        wrote: false,
      };
    }
    return decideQuarantine({ ...input, tx, state, provider, source, now });
  });

  if (written.alert !== undefined) await raiseModelAlert(written.alert);
  if (written.wrote) await invalidateLiveRegistry();
  return written.outcome;
};

/** What one pass of the ladder decided, before anything leaves the transaction. */
interface QuarantineWrite {
  outcome: QuarantineOutcome;
  alert?: RaiseAlertInput;
  /** Whether the row changed, and therefore whether the fleet must reload. */
  wrote: boolean;
}

/**
 * The escalation ladder itself, inside the caller's transaction.
 *
 * Split out only so `quarantineProvider` reads as lock → decide → commit →
 * announce; the rungs and their order are documented on that function.
 */
const decideQuarantine = async (input: {
  tx: Transaction;
  state: LiveModelState;
  modelKey: string;
  provider: string;
  transport: TransportId;
  kind: IncidentKind;
  reason: string;
  source: ModelStateSource;
  now: Date;
  incidentIds?: string[];
}): Promise<QuarantineWrite> => {
  const { modelKey, provider, source, state, now, tx } = input;
  const entry: QuarantineEntry = {
    provider,
    transport: input.transport,
    kind: input.kind,
    quarantinedAt: now.toISOString(),
    releaseAt: new Date(
      now.getTime() + QUARANTINE_DAYS * 24 * 60 * 60_000,
    ).toISOString(),
    incidentIds: input.incidentIds ?? [],
    reason: input.reason,
  };
  // Drop any expired entry for the same pair so the column holds current state,
  // not history — the incidents table is the history.
  const quarantines = [
    ...state.quarantinedProviders.filter(
      (existing) =>
        !(
          existing.provider === provider &&
          existing.transport === input.transport
        ),
    ),
    entry,
  ];

  const vetted = vettedRemaining(state, input.transport, provider, now);
  const clean = cleanEndpointCount(state, input.transport, provider, now);
  const headline = `${provider} removed from ${input.modelKey} — ${HUMAN_KIND[input.kind]}. ${input.reason}`;
  const context = {
    kind: input.kind,
    transport: input.transport,
    incidentIds: entry.incidentIds,
  };

  const row = eq(modelLiveState.profileKey, modelKey);

  // 1 — the ordinary case.
  if (vetted === undefined ? clean > 0 : vetted > 0) {
    await tx
      .update(modelLiveState)
      .set({ quarantinedProviders: quarantines, source })
      .where(row);
    return {
      outcome: {
        kind: "quarantined",
        entry,
        remaining: vetted ?? clean,
        remainingSource: vetted === undefined ? "endpoints" : "vetted",
      },
      alert: {
        kind: "quarantine",
        severity: "critical",
        modelKey,
        provider,
        message: `${headline} ${(vetted ?? clean).toString()} upstream(s) left; re-probe due ${entry.releaseAt.slice(0, 10)}.`,
        context,
      },
      wrote: true,
    };
  }

  // 2 — the vetted pool is exhausted but the transport has other hosts.
  if (vetted !== undefined && clean > 0) {
    await tx
      .update(modelLiveState)
      .set({ quarantinedProviders: quarantines, poolWidened: true, source })
      .where(row);
    return {
      outcome: { kind: "pool-widened", entry, remaining: clean },
      alert: {
        kind: "quarantine",
        severity: "critical",
        modelKey,
        provider,
        message: `${headline} That was the last VETTED upstream, so routing is now OPEN to the ${clean.toString()} remaining endpoint(s) minus the quarantined ones — an unmeasured host beats a known-bad one. The vetted pool is restored automatically once quarantines expire and re-probe clean.`,
        context: { ...context, poolWidened: true, remaining: clean },
      },
      wrote: true,
    };
  }

  // 3 — nothing clean here; the same model exists on the other transport.
  const alternate = alternateTransport(state, input.transport);
  if (alternate !== undefined) {
    await tx
      .update(modelLiveState)
      .set({
        quarantinedProviders: quarantines,
        transport: alternate,
        poolWidened: false,
        source,
      })
      .where(row);
    return {
      outcome: {
        kind: "transport-switched",
        entry,
        from: input.transport,
        to: alternate,
      },
      alert: {
        kind: "quarantine",
        severity: "critical",
        modelKey,
        provider,
        message: `${headline} No clean endpoint left on ${input.transport}, so ${modelKey} was SWITCHED to ${alternate}, which serves it from a different set of hosts. Verify cost and caching on the new transport.`,
        context: { ...context, switchedTo: alternate },
      },
      wrote: true,
    };
  }

  // 4 — nothing anywhere. Keep serving (an outage is worse), but stop being
  // anyone's first choice. Note what this rung does NOT write: the quarantine
  // entry is discarded, so the host stays in the pool. The MODEL steps down.
  await tx
    .update(modelLiveState)
    .set({ lastResort: true, health: "failing", source })
    .where(row);
  return {
    outcome: { kind: "last-resort" },
    alert: {
      kind: "quarantine-skipped",
      severity: "critical",
      modelKey,
      provider,
      message: `${provider} ${HUMAN_KIND[input.kind]} on ${modelKey} and it is the LAST usable upstream on every transport. It stays in service — an empty pool is a hard outage — but ${modelKey} is now last-resort: roles bound to it fall back to their fallback model, and teams that selected it fall back to the default. Widen the pool, add a transport, or replace the model.`,
      context: { ...context, lastResort: true },
    },
    wrote: true,
  };
};

/**
 * Whether an outcome removed the upstream from the pool.
 *
 * Exists for callers that genuinely only need the old boolean — and it is
 * deliberately NOT true for `last-resort`, which changed the row without
 * changing the pool. That distinction is the one the boolean used to hide.
 */
export const quarantineChanged = (outcome: QuarantineOutcome): boolean =>
  outcome.kind === "quarantined" ||
  outcome.kind === "pool-widened" ||
  outcome.kind === "transport-switched";

/**
 * Put an upstream back in a model's pool. Used by the sync after a clean
 * re-probe, and by a person undoing a quarantine by hand.
 *
 * Reports what it did. It used to return `void` and simply stop when the pair
 * was not quarantined, so the only way to tell a release from a no-op was to
 * re-read the row and compare array lengths — and the one fact that explains
 * the no-op, that the host is quarantined on a DIFFERENT transport, was
 * computed here and thrown away.
 */
export const releaseProvider = async (input: {
  modelKey: string;
  provider: string;
  transport: TransportId;
  reason: string;
  /** Who is asking. Decides the `source` stamp; see `ModelWriteActor`. */
  actor: ModelWriteActor;
}): Promise<ReleaseOutcome> => {
  const provider = normalizeProviderName(input.provider);

  // Same lock as the quarantine path, and for the same column: this rewrites
  // `quarantined_providers` from a value it just read, so an unlocked pass
  // racing the breaker can silently resurrect the entry it is removing.
  const outcome = await db.transaction(async (tx): Promise<ReleaseOutcome> => {
    const state = await readLiveStateRowForUpdate(tx, input.modelKey);
    if (!state) return { kind: "no-live-row" };
    const released = state.quarantinedProviders.find(
      (entry) =>
        entry.provider === provider && entry.transport === input.transport,
    );
    if (released === undefined) {
      return {
        kind: "not-quarantined",
        elsewhere: state.quarantinedProviders.filter(
          (entry) => entry.transport !== input.transport,
        ),
      };
    }
    const kept = state.quarantinedProviders.filter(
      (entry) => entry !== released,
    );

    // Restoring a member re-narrows routing to the vetted pool and lifts the
    // last-resort flag, provided that pool has someone left in it.
    const stillQuarantined = new Set(
      kept
        .filter(
          (entry) =>
            entry.transport === input.transport &&
            new Date(entry.releaseAt).getTime() > Date.now(),
        )
        .map((entry) => entry.provider),
    );
    const vetted = state.providerPool[input.transport]?.only;
    const vettedLeft = vetted
      ? vetted.filter((p) => !stillQuarantined.has(p)).length
      : 1;

    await tx
      .update(modelLiveState)
      .set({
        quarantinedProviders: kept,
        poolWidened: vettedLeft > 0 ? false : state.poolWidened,
        lastResort: false,
        // This write recorded no provenance at all until 2026-08-31, alone
        // among its siblings: a released row kept whatever `source` it had.
        source: sourceForActor(input.actor),
      })
      .where(eq(modelLiveState.profileKey, input.modelKey));

    return {
      kind: "released",
      entry: released,
      poolRenarrowed: state.poolWidened && vettedLeft > 0,
      lastResortLifted: state.lastResort,
    };
  });

  if (outcome.kind !== "released") return outcome;
  await invalidateLiveRegistry();
  await raiseModelAlert({
    kind: "release",
    severity: "info",
    modelKey: input.modelKey,
    provider,
    message: `${provider} restored to ${input.modelKey}. ${input.reason}`,
  });
  return outcome;
};

/**
 * File an incident and quarantine the upstream if it has now failed often
 * enough. The single entry point for the runtime detectors; it never throws,
 * because a turn must not fail because its own quality monitoring did.
 */
export const reportIncident = async (
  input: RecordIncidentInput & { now?: Date },
): Promise<void> => {
  const now = input.now ?? new Date();
  try {
    const incidentId = await recordProviderIncident(input);
    if (incidentId === undefined) return;

    const threshold = THRESHOLDS[input.kind];
    const generations = await countRecentIncidents({
      modelKey: input.modelKey,
      provider: input.provider,
      kind: input.kind,
      windowMinutes: threshold.windowMinutes,
      now,
    });
    if (generations < threshold.generations) return;

    const incidentIds = await recentIncidentIds({
      modelKey: input.modelKey,
      provider: input.provider,
      kind: input.kind,
      windowMinutes: threshold.windowMinutes,
      now,
    });
    const outcome = await quarantineProvider({
      modelKey: input.modelKey,
      provider: input.provider,
      transport: input.transport,
      kind: input.kind,
      reason: `${generations.toString()} distinct generations in ${threshold.windowMinutes.toString()} min.`,
      // Nobody typed a command to get here: a detector tripped inside a turn.
      actor: { kind: "breaker" },
      incidentIds,
      now,
    });
    // Logged rather than returned: the detectors call this fire-and-forget, so
    // the rung would have nowhere to go. It is worth a line either way — the
    // alert says what happened to the POOL, this says which branch produced it.
    console.info(
      `[model-breaker] ${input.provider} on ${input.modelKey}: ${outcome.kind}`,
    );
  } catch (err: unknown) {
    console.error(
      "[model-breaker] incident handling failed:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** Shipped numbers, exported so the tests assert them rather than restate them. */
export const BREAKER_THRESHOLDS: Readonly<Record<IncidentKind, Threshold>> =
  THRESHOLDS;
export const BREAKER_QUARANTINE_DAYS = QUARANTINE_DAYS;
