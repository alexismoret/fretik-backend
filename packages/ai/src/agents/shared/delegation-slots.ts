import { turnRootOf } from "../../lib/turn-usage";
import { parseIntEnv } from "./env";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * How many sub-agents one turn may run — at once, and in all.
 *
 * Both used to be prose. The prompt said "cap parallel dispatch at 3" and the
 * step budget allowed 12 calls a step, so the real limit was whatever the
 * model read into the sentence; Anthropic measured the failure this invites on
 * their own research agent — fifty sub-agents spawned for a simple query. Code
 * enforces it now, in two ways that do different jobs:
 *
 *  - **At once.** A dispatch beyond the concurrency cap WAITS for a slot
 *    rather than failing: the model asked for independent work in parallel,
 *    and queueing the surplus delivers exactly that, a little later. Nothing
 *    to retry, nothing to explain.
 *  - **In all.** A dispatch beyond the per-turn total is REFUSED before it
 *    starts. That one is a budget, and a budget that queues is not one.
 *
 * In memory, not Redis: a turn is served end to end by one process — the
 * handler, its tools, and every sub-agent they dispatch (see `turn-usage.ts`
 * for the same argument) — so nothing else can hold or need these counters.
 */

const maxConcurrent = (): number =>
  parseIntEnv("DISPATCH_AGENT_MAX_CONCURRENT", {
    fallback: 5,
    min: 1,
    max: 12,
  });

const maxPerTurn = (): number =>
  parseIntEnv("DISPATCH_AGENT_MAX_PER_TURN", {
    fallback: 10,
    min: 1,
    max: 50,
  });

interface TurnSlots {
  dispatched: number;
  running: number;
  waiting: (() => void)[];
  touchedAt: number;
}

const turns = new Map<string, TurnSlots>();

/** Far above any turn, including a workflow turn's hour. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const sweep = (now: number): void => {
  for (const [key, slots] of turns) {
    if (
      slots.running === 0 &&
      slots.waiting.length === 0 &&
      now - slots.touchedAt > MAX_AGE_MS
    ) {
      turns.delete(key);
    }
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

const slotsFor = (key: string): TurnSlots => {
  const now = Date.now();
  sweep(now);
  const existing = turns.get(key);
  if (existing !== undefined) {
    existing.touchedAt = now;
    return existing;
  }
  const created: TurnSlots = {
    dispatched: 0,
    running: 0,
    waiting: [],
    touchedAt: now,
  };
  turns.set(key, created);
  return created;
};

export type DispatchVerdict =
  { admitted: true } | { admitted: false; limit: number };

/**
 * Count one dispatch against its turn's total, or refuse it over the limit.
 * Takes no slot: a background dispatch is counted here, in the turn that
 * launched it, and waits for its slot afterwards under the conversation's key
 * (`backgroundSlotKey`), since it outlives the turn.
 */
export const claimDispatch = (key: string): DispatchVerdict => {
  const slots = slotsFor(key);
  const limit = maxPerTurn();
  if (slots.dispatched >= limit) return { admitted: false, limit };
  slots.dispatched += 1;
  return { admitted: true };
};

/**
 * Wait for a slot under `key`. MUST be given back through
 * `releaseDelegationSlot`, whatever happens to the run.
 */
export const acquireDelegationSlot = async (key: string): Promise<void> => {
  const slots = slotsFor(key);
  if (slots.running >= maxConcurrent()) {
    // The slot is handed over by `releaseDelegationSlot` with `running`
    // unchanged — never freed and re-taken, which would let a dispatch that
    // arrives in between slip past the cap.
    await new Promise<void>((resolve) => {
      slots.waiting.push(resolve);
    });
  } else {
    slots.running += 1;
  }
};

/**
 * The key background sub-agents take their slots under: the conversation, not
 * the turn — they keep running after the turn that launched them, beside the
 * next one's. In this process only: a conversation whose turns land on two
 * replicas runs up to the cap on each, which is a soft limit, not a leak.
 */
export const backgroundSlotKey = (conversationId: string): string =>
  `background:${conversationId}`;

/**
 * Admit one dispatch into its turn, or refuse it over the per-turn total. An
 * admitted dispatch then waits for a slot and MUST give it back through
 * `releaseDelegationSlot`, whatever happens to the run.
 */
export const admitDelegation = async (
  key: string,
): Promise<DispatchVerdict> => {
  const verdict = claimDispatch(key);
  if (!verdict.admitted) return verdict;
  await acquireDelegationSlot(key);
  return verdict;
};

/** Hand the slot to the next waiting dispatch of the same turn, or free it. */
export const releaseDelegationSlot = (key: string): void => {
  const slots = turns.get(key);
  if (slots === undefined) return;
  slots.touchedAt = Date.now();
  const next = slots.waiting.shift();
  if (next !== undefined) {
    next();
    return;
  }
  slots.running = Math.max(0, slots.running - 1);
};

/** Test seam: the counters are process-wide, and a suite is not a process. */
export const resetDelegationSlots = (): void => {
  turns.clear();
};
