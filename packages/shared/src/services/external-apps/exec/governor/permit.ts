// oxlint-disable no-await-in-loop
import {
  govAcquire,
  govBlock,
  govRelease,
  readGovernorStats,
  type GovernorStats,
  type GovernorVerdict,
} from "./lua";
import {
  resolveGovernorPolicy,
  type GovernorPolicy,
  type PolicyConnection,
} from "./policy";
import {
  classifyUpstreamError,
  UpstreamRateLimitedError,
} from "./upstream-error";

/**
 * Every call this deployment makes to somebody else's API goes through here.
 *
 * There are exactly four places that reach a third party — the read executor
 * (sandbox, page and sync reads), the page writer, the approval-plan executor
 * and the MCP transport — and the governor wraps all four. That is the whole
 * design: a budget enforced at three of four doors is not a budget, and adding
 * a fifth door is the one change that can break this.
 *
 * ## Interactive and background are different callers, not different limits
 *
 * A person waiting on a page has a few seconds; a sync run has a deadline
 * minutes away and something useful to do with a refusal (suspend, resume
 * later). So `mode` decides only HOW LONG to wait for a permit, never whether
 * the budget applies:
 *
 *  - `interactive` waits up to the policy's `maxWaitMs`, then raises. The
 *    message names the app and says what to do about it, because a user reading
 *    "rate limited" with no app name has been told nothing.
 *  - `background` waits until its own deadline. A sync leg that cannot get a
 *    permit stops and is re-queued at the retry time — which is why the error
 *    carries `retryAfterMs` rather than just failing.
 *
 * ## Fail open, deliberately
 *
 * A Redis this process cannot reach stops BullMQ outright, so background work
 * is already halted; what remains is interactive reads, and refusing those
 * because we cannot measure them is a worse outage than the one we are
 * protecting against. `EXTERNAL_APP_GOVERNOR_FAIL_OPEN=false` inverts it for a
 * deployment that would rather stop.
 *
 * ## A 429 is shared, not survived
 *
 * When the app refuses, the refusal is written cluster-wide before the error
 * propagates, so the next caller — in another replica, for another team —
 * waits instead of confirming it. This is the only part of the governor that
 * learns something the manifest did not know.
 */

export type GovernorMode =
  { kind: "interactive" } | { kind: "background"; deadlineAt: number };

export interface PermitOptions {
  /**
   * How long one call may hold its seat before it is assumed abandoned. Must
   * comfortably EXCEED the caller's own timeout — a hold that expires under a
   * live caller is how two calls end up overlapping on a connection that can
   * only take one.
   */
  holdMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll no slower than this: a seat can free at any instant. */
const MAX_SLEEP_MS = 250;

const failOpen = (): boolean =>
  (process.env.EXTERNAL_APP_GOVERNOR_FAIL_OPEN ?? "true")
    .trim()
    .toLowerCase() !== "false";

let warnedAt = 0;
const warnGovernorDown = (error: unknown): void => {
  const now = Date.now();
  if (now - warnedAt < 60_000) return;
  warnedAt = now;
  console.warn(
    "[governor] Redis unreachable — outgoing calls are unmetered until it returns:",
    error instanceof Error ? error.message : error,
  );
};

const makeToken = (): string =>
  `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const budgetEndsAt = (mode: GovernorMode, policy: GovernorPolicy): number =>
  mode.kind === "background" ? mode.deadlineAt : Date.now() + policy.maxWaitMs;

/**
 * Wait for a permit, run `fn`, release.
 *
 * Returns the token so the seat is given back in `finally` even when `fn`
 * throws — a leaked seat is a connection that gets quieter every day until the
 * hold expires.
 */
export const withUpstreamPermit = async <T>(
  connection: PolicyConnection,
  mode: GovernorMode,
  opts: PermitOptions,
  fn: () => Promise<T>,
): Promise<T> => {
  const policy = resolveGovernorPolicy(connection);

  // Nothing declared, nothing defaulted, no seat limit: the governor has no
  // opinion about this connection and should not cost it a round trip.
  if (
    policy.perConnection === undefined &&
    policy.perProvider === undefined &&
    policy.maxConcurrent <= 0
  ) {
    return await runGoverned(policy, fn);
  }

  const token = makeToken();
  const deadline = budgetEndsAt(mode, policy);

  for (;;) {
    const verdict = await tryAcquire(policy, token, opts.holdMs);
    // Redis is unreachable and this deployment would rather be unmetered than
    // silent. The call goes out ungoverned; the warning is throttled so an
    // outage does not also flood the log.
    if (verdict === undefined) return await fn();

    if (verdict.admitted) {
      try {
        return await runGoverned(policy, fn);
      } finally {
        await govRelease(policy, token).catch(() => undefined);
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new UpstreamRateLimitedError(
        policy.connectionId,
        policy.displayName,
        Math.max(verdict.waitMs, 1),
        verdict.reason,
      );
    }
    // Jittered, like `redis-lock`: N callers refused in the same instant would
    // otherwise retry in lockstep and collide again, forever.
    const base = Math.min(verdict.waitMs, MAX_SLEEP_MS, remaining);
    await sleep(Math.max(base, 10) + Math.random() * 25);
  }
};

/** `undefined` = the governor could not be consulted and we go ahead anyway. */
const tryAcquire = async (
  policy: GovernorPolicy,
  token: string,
  holdMs: number,
): Promise<GovernorVerdict | undefined> => {
  try {
    return await govAcquire(policy, token, holdMs);
  } catch (error) {
    if (!failOpen()) throw error;
    warnGovernorDown(error);
    return undefined;
  }
};

/**
 * What this connection and its provider have spent today — for the connection
 * screen. Never read to make a decision: the decision is the Lua script's, and
 * a second reader of the same counters would be a second opinion.
 */
export const readUpstreamStats = async (
  connection: PolicyConnection,
  day?: string,
): Promise<{ connection: GovernorStats; provider: GovernorStats }> => {
  const policy = resolveGovernorPolicy(connection);
  const [own, shared] = await Promise.all([
    readGovernorStats("conn", policy.connectionId, day),
    readGovernorStats("prov", policy.providerKey, day),
  ]);
  return { connection: own, provider: shared };
};

/**
 * Run the call and, if the app refuses it, tell everyone before re-throwing.
 *
 * The refusal is recorded on the scope that can explain it: a declared
 * `perProvider` budget means the ceiling is shared, so the block has to be too
 * — otherwise every other connection of the provider spends its own 429
 * discovering the same thing.
 */
const runGoverned = async <T>(
  policy: GovernorPolicy,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    const refusal = classifyUpstreamError(error, policy.retryAfterHeaders);
    if (refusal === undefined) throw error;
    const forMs = refusal.retryAfterMs ?? policy.defaultRetryAfterMs;
    const scope = policy.perProvider === undefined ? "conn" : "prov";
    await govBlock(policy, scope, forMs).catch(() => undefined);
    throw new UpstreamRateLimitedError(
      policy.connectionId,
      policy.displayName,
      Math.min(forMs, policy.maxBlockMs),
      `the app answered 429 (${refusal.detectedBy})`,
    );
  }
};
