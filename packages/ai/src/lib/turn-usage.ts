/**
 * What a turn spent, counted by the process that spent it.
 *
 * Cost was already knowable — every registry call carries the upstream's own
 * billed figure (`usage: { include: true }`, read by `extractUpstreamCost`) —
 * and nothing wrote it down anywhere the turn itself could reach. So the only
 * way to ask "what did this page cost" was to sum a trace's observations in
 * Langfuse, which is someone else's ingestion pipeline reporting on us. On
 * 2026-09-05 that pipeline was multiplying every observation by 22 and no
 * consumer could tell (see `lib/langfuse-registration.ts`); two code changes
 * were argued from the inflated numbers.
 *
 * This ledger is the first-party answer. Langfuse stays, as the cross-check.
 *
 * ## Why memory and not Redis
 *
 * A turn is served end to end by ONE process: the handler, its tools, and
 * every sub-agent a tool dispatches all run inside the same request. Nobody
 * else can read these counters and nothing needs them after the turn ends —
 * the durable copies are `page_versions.meta.usage` and the Langfuse
 * observation, both written from here before the entry is dropped. A Redis
 * round trip per model step would buy nothing but a failure mode.
 *
 * Consequences, both accepted: a crashed process loses the ledger of a turn it
 * also lost, and a `--hot` reload in dev empties it mid-turn.
 *
 * ## The key is the TURN, not the agent
 *
 * A delegate's trace id is the turn's with a suffix (`${traceId}.page`,
 * `.sub`), the same convention `reviewScope` folds on. Everything under one
 * turn therefore lands in one entry, split into a bucket per agent, so
 * "what did the page builder spend" and "what did this turn spend" are the
 * same read.
 */
import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { extractUpstreamCost } from "./langfuse-cost";

/** One agent's spend inside a turn. Every field is a sum over steps. */
export interface StepUsage {
  steps: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /**
   * How many of `steps` actually reported a cost.
   *
   * Below `steps`, `costUsd` is a floor rather than a total — a transport that
   * publishes no cost (or a call that failed before billing) contributes
   * tokens and no money. Named so a partial figure cannot be read as a
   * complete one.
   */
  costedSteps: number;
}

export interface TurnUsage {
  byAgent: Record<string, StepUsage>;
  total: StepUsage;
}

const emptyUsage = (): StepUsage => ({
  steps: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  costedSteps: 0,
});

const addInto = (target: StepUsage, step: StepUsage): void => {
  target.steps += step.steps;
  target.inputTokens += step.inputTokens;
  target.cacheReadTokens += step.cacheReadTokens;
  target.cacheWriteTokens += step.cacheWriteTokens;
  target.outputTokens += step.outputTokens;
  target.reasoningTokens += step.reasoningTokens;
  target.costUsd += step.costUsd;
  target.costedSteps += step.costedSteps;
};

/** The sum of two ledgers, neither mutated. */
export const mergeUsage = (a: StepUsage, b: StepUsage): StepUsage => {
  const merged = emptyUsage();
  addInto(merged, a);
  addInto(merged, b);
  return merged;
};

/**
 * What one model step used. Pure — the same reducer serves live and replay.
 *
 * Every field is read defensively, `usage` itself included. The SDK types it
 * as present, and a step that arrives without it is still a step that
 * happened: counting it as one with zero tokens keeps `steps` honest, whereas
 * throwing here would fail the turn over a metric nobody asked for.
 */
export const summarizeStep = (step: {
  usage?: LanguageModelUsage | undefined;
  providerMetadata?: ProviderMetadata | undefined;
}): StepUsage => {
  const cost = extractUpstreamCost(step.providerMetadata);
  const usage = step.usage;
  return {
    steps: 1,
    inputTokens: usage?.inputTokens ?? 0,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    costUsd: cost ?? 0,
    costedSteps: cost === undefined ? 0 : 1,
  };
};

/**
 * What a whole run used, from the steps it returned.
 *
 * Read straight off the result rather than out of the ledger, so a sub-agent
 * reports its own spend even when it ran on a retry the ledger also holds.
 */
export const summarizeRunUsage = (
  steps: readonly {
    usage?: LanguageModelUsage | undefined;
    providerMetadata?: ProviderMetadata | undefined;
  }[],
): StepUsage => {
  const total = emptyUsage();
  for (const step of steps) addInto(total, summarizeStep(step));
  return total;
};

/**
 * The turn a trace id belongs to. A delegate carries the turn's id plus a
 * suffix, so one split folds every agent of a turn onto one key.
 */
export const turnRootOf = (traceId: string): string =>
  traceId.split(".")[0] ?? traceId;

interface Entry {
  usage: TurnUsage;
  touchedAt: number;
}

/**
 * Bounds. A turn that never reaches its handler's finally block (a process
 * killed mid-stream) would otherwise keep its entry forever, so the map is
 * swept by age and capped by count. Both are far above any real turn: the
 * longest page build has a 25-minute deadline, and one process serves a
 * handful of concurrent turns.
 */
const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

const ledger = new Map<string, Entry>();

const sweep = (now: number): void => {
  for (const [key, entry] of ledger) {
    if (now - entry.touchedAt > MAX_AGE_MS) ledger.delete(key);
  }
  // Insertion order is oldest first, and re-touching does not reorder — good
  // enough for a backstop whose only job is to refuse to grow without bound.
  while (ledger.size > MAX_ENTRIES) {
    const oldest = ledger.keys().next();
    if (oldest.done) break;
    ledger.delete(oldest.value);
  }
};

/** Fold one step into its turn's ledger. Never throws. */
export const recordStepUsage = (
  traceId: string | undefined,
  agentId: string,
  step: StepUsage,
): void => {
  if (traceId === undefined) return;
  const key = turnRootOf(traceId);
  const now = Date.now();
  const entry = ledger.get(key) ?? {
    usage: { byAgent: {}, total: emptyUsage() },
    touchedAt: now,
  };
  const bucket = entry.usage.byAgent[agentId] ?? emptyUsage();
  addInto(bucket, step);
  entry.usage.byAgent[agentId] = bucket;
  addInto(entry.usage.total, step);
  entry.touchedAt = now;
  ledger.set(key, entry);
  sweep(now);
};

/** What this turn has spent so far, or `undefined` when nothing recorded it. */
export const readTurnUsage = (
  traceId: string | undefined,
): TurnUsage | undefined =>
  traceId === undefined ? undefined : ledger.get(turnRootOf(traceId))?.usage;

/** One agent's bucket, or `undefined` when that agent has not run. */
export const readAgentUsage = (
  traceId: string | undefined,
  agentId: string,
): StepUsage | undefined => readTurnUsage(traceId)?.byAgent[agentId];

/** Drop a finished turn. Called once the durable copies are written. */
export const forgetTurnUsage = (traceId: string | undefined): void => {
  if (traceId !== undefined) ledger.delete(turnRootOf(traceId));
};

/** Test seam: the ledger is process-wide, and a suite is not a process. */
export const resetTurnUsage = (): void => {
  ledger.clear();
};
