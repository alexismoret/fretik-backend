import { turnRootOf } from "../../lib/turn-usage";
import { parseIntEnv } from "./env";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * How many sub-agents one turn may start, and one conversation may have
 * running at once.
 *
 * Both used to be prose. The prompt said "cap parallel dispatch at 3" and the
 * step budget allowed 12 calls a step, so the real limit was whatever the
 * model read into the sentence; Anthropic measured the failure this invites on
 * their own research agent — fifty sub-agents spawned for a simple query. Code
 * enforces it now, and a dispatch over either limit is REFUSED before it
 * starts: both are budgets, and a budget that queues is not one.
 *
 *  - **Per turn** (here, in memory): a turn is served end to end by one
 *    process — the handler and every tool it calls — so nothing else can hold
 *    or need the counter.
 *  - **Open per conversation** (`dispatchAgent`, from the task rows): the runs
 *    outlive the turn and run on any replica, so only the rows know.
 *
 * How many run at once across the fleet is the queue worker's concurrency
 * (`services/sub-agents/worker.ts`); a dispatch beyond it waits in the queue.
 */

const maxPerTurn = (): number =>
  parseIntEnv("DISPATCH_AGENT_MAX_PER_TURN", {
    fallback: 10,
    min: 1,
    max: 50,
  });

/** Sub-agents one conversation may have running at once. */
export const maxOpenSubAgents = (): number =>
  parseIntEnv("DISPATCH_AGENT_MAX_OPEN", {
    fallback: 10,
    min: 1,
    max: 50,
  });

interface TurnCount {
  dispatched: number;
  touchedAt: number;
}

const turns = new Map<string, TurnCount>();

/** Far above any turn, including a workflow turn's hour. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const sweep = (now: number): void => {
  for (const [key, count] of turns) {
    if (now - count.touchedAt > MAX_AGE_MS) turns.delete(key);
  }
};

/**
 * The turn a dispatch counts against: the parent's trace root, which every
 * agent of one turn shares. A context with no trace id falls back to its
 * conversation, and one with neither is a caller outside any turn (a test, a
 * script) that gets its own bucket per call.
 */
export const delegationTurnKey = (ctx: AgentRuntimeContext): string =>
  ctx.traceId !== undefined
    ? turnRootOf(ctx.traceId)
    : (ctx.conversationId ?? `detached:${crypto.randomUUID()}`);

export type DispatchVerdict =
  { admitted: true } | { admitted: false; limit: number };

/** Count one dispatch against its turn's total, or refuse it over the limit. */
export const claimDispatch = (key: string): DispatchVerdict => {
  const now = Date.now();
  sweep(now);
  const count = turns.get(key) ?? { dispatched: 0, touchedAt: now };
  count.touchedAt = now;
  turns.set(key, count);
  const limit = maxPerTurn();
  if (count.dispatched >= limit) return { admitted: false, limit };
  count.dispatched += 1;
  return { admitted: true };
};

/** Test seam: the counters are process-wide, and a suite is not a process. */
export const resetDelegationSlots = (): void => {
  turns.clear();
};
