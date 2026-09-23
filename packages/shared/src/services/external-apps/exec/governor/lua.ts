import { redis } from "../../../../lib/redis";
import { rateKey, semaphoreKey, statsDay, statsKey } from "./keys";
import type { GovernorPolicy } from "./policy";

/**
 * One round trip decides everything, or the decision is wrong.
 *
 * Three questions have to be answered together — is this app blocked, is the
 * connection already at its concurrency, is either rate bucket full — and any
 * split between them is a race with a real cost. Two processes reading a
 * counter and then incrementing it both see room; two processes checking a
 * semaphore and then joining it both get in. So it is one script, and the only
 * thing the caller does is act on the verdict.
 *
 * The order inside is the order of consequences, cheapest and most absolute
 * first: a block (somebody already got a 429 — nobody may pass), then
 * concurrency (a seat is either free or not), then pacing. And the pacing of
 * the two scopes is COMPUTED before either is committed, because a request
 * refused by the provider bucket must not have spent the connection's
 * allowance on the way — it will be retried, and paying twice for one call is
 * how a 300/min budget delivers 150.
 *
 * ## The pacing itself (GCRA)
 *
 * State is one number per bucket: `tat`, the theoretical arrival time — the
 * instant at which the bucket will have fully paid for everything admitted so
 * far. Each admitted call pushes it forward by one emission interval
 * `T = perSeconds × 1000 / requests`. A call is admitted when its new `tat` is
 * no further ahead than the burst allowance `burst × T`.
 *
 * Two properties are why this and not a fixed window. It has no edge: a fixed
 * 60-second window lets 2× the budget through across a boundary, which is
 * exactly when a fan-out lands. And a refusal knows its own answer — the wait
 * is `newTat - burstAllowance - now`, a number, not a poll.
 *
 * With `burst` defaulting to `requests`, "600 per minute" admits 600
 * back-to-back and paces the 601st, which is what an API that publishes that
 * number means.
 *
 * ## What it is NOT
 *
 * Not a source of truth. Every key here expires, a flushed Redis costs one
 * window of over-permission, and nothing in the system reads this state to
 * decide what an answer MEANS. That is what lets `permit.ts` fail open when
 * Redis is unreachable rather than refusing traffic it cannot measure.
 */

const GOV_ACQUIRE = `
local now        = tonumber(ARGV[1])
local token      = ARGV[2]
local t_conn     = tonumber(ARGV[3])
local burst_conn = tonumber(ARGV[4])
local t_prov     = tonumber(ARGV[5])
local burst_prov = tonumber(ARGV[6])
local max_conc   = tonumber(ARGV[7])
local hold_ms    = tonumber(ARGV[8])
local state_ttl  = tonumber(ARGV[9])
local stats_ttl  = tonumber(ARGV[10])

-- A TTL is only ever extended. 'govBlock' sets one that covers the block, and
-- an acquire that shortened it would lift the block early.
local function bump_ttl(key, ttl)
  local cur = redis.call('PTTL', key)
  if cur < ttl then redis.call('PEXPIRE', key, ttl) end
end

local function blocked_for(key)
  local until_ms = tonumber(redis.call('HGET', key, 'blocked_until') or '0')
  if until_ms > now then return until_ms - now end
  return 0
end

-- 1. Somebody already hit a 429. Nobody passes until it lifts.
local wait = blocked_for(KEYS[1])
if wait == 0 then wait = blocked_for(KEYS[2]) end
if wait > 0 then return {0, math.ceil(wait), 'blocked'} end

-- 2. A seat is free or it is not. Expire abandoned holds first: a replica that
--    died mid-call must not cost this connection a seat forever.
if max_conc > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - hold_ms)
  if redis.call('ZCARD', KEYS[3]) >= max_conc then
    -- No deadline to report: a holder can finish at any instant, so the caller
    -- polls rather than sleeping out a number this script would have to invent.
    return {0, 50, 'concurrency'}
  end
end

-- 3. Pacing, both scopes, computed only.
local new_conn = -1
local new_prov = -1
if t_conn > 0 then
  local tat = tonumber(redis.call('HGET', KEYS[1], 'tat') or '0')
  if tat < now then tat = now end
  local nt = tat + t_conn
  if now < nt - burst_conn then
    return {0, math.ceil(nt - burst_conn - now), 'conn_rate'}
  end
  new_conn = nt
end
if t_prov > 0 then
  local tat = tonumber(redis.call('HGET', KEYS[2], 'tat') or '0')
  if tat < now then tat = now end
  local nt = tat + t_prov
  if now < nt - burst_prov then
    return {0, math.ceil(nt - burst_prov - now), 'prov_rate'}
  end
  new_prov = nt
end

-- 4. Admitted — now, and only now, spend the allowance.
if new_conn >= 0 then
  redis.call('HSET', KEYS[1], 'tat', new_conn)
  bump_ttl(KEYS[1], state_ttl)
end
if new_prov >= 0 then
  redis.call('HSET', KEYS[2], 'tat', new_prov)
  bump_ttl(KEYS[2], state_ttl)
end
if max_conc > 0 then
  redis.call('ZADD', KEYS[3], now, token)
  bump_ttl(KEYS[3], hold_ms * 2)
end
redis.call('HINCRBY', KEYS[4], 'calls', 1)
redis.call('EXPIRE', KEYS[4], stats_ttl)
redis.call('HINCRBY', KEYS[5], 'calls', 1)
redis.call('EXPIRE', KEYS[5], stats_ttl)
return {1, 0, 'ok'}
`;

/**
 * Record that this bucket answered 429, until `untilMs`.
 *
 * `max` rather than overwrite: two callers racing on the same refusal must not
 * let the one with the shorter reading shorten the block. The stats counter is
 * bumped in the same trip so a 429 leaves a trace even when the retry succeeds
 * and nothing else ever mentions it.
 */
const GOV_BLOCK = `
local now      = tonumber(ARGV[1])
local until_ms = tonumber(ARGV[2])
local ttl      = tonumber(ARGV[3])
local stats_ttl = tonumber(ARGV[4])
local cur = tonumber(redis.call('HGET', KEYS[1], 'blocked_until') or '0')
if until_ms > cur then
  redis.call('HSET', KEYS[1], 'blocked_until', until_ms)
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
redis.call('HINCRBY', KEYS[2], 'rate_limited', 1)
redis.call('EXPIRE', KEYS[2], stats_ttl)
return redis.call('HGET', KEYS[1], 'blocked_until')
`;

export type GovernorReason =
  "ok" | "blocked" | "concurrency" | "conn_rate" | "prov_rate";

export interface GovernorVerdict {
  admitted: boolean;
  /** How long to wait before asking again. 0 when admitted. */
  waitMs: number;
  reason: GovernorReason;
}

const STATS_TTL_SECONDS = 3 * 24 * 60 * 60;

/** `perSeconds × 1000 / requests`, the interval one call costs the bucket. */
const emissionInterval = (requests: number, perSeconds: number): number =>
  (perSeconds * 1000) / requests;

const isVerdictTuple = (
  value: unknown,
): value is [number, number, string | Buffer] =>
  Array.isArray(value) && value.length === 3;

const asReason = (raw: string): GovernorReason => {
  if (
    raw === "ok" ||
    raw === "blocked" ||
    raw === "concurrency" ||
    raw === "conn_rate" ||
    raw === "prov_rate"
  ) {
    return raw;
  }
  return "ok";
};

/**
 * Ask for one permit. The token is what a later release names, so it has to be
 * the caller's — a token minted here and forgotten would leak a seat until the
 * hold expired.
 */
export const govAcquire = async (
  policy: GovernorPolicy,
  token: string,
  holdMs: number,
  now: number = Date.now(),
): Promise<GovernorVerdict> => {
  const conn = policy.perConnection;
  const prov = policy.perProvider;
  const tConn =
    conn === undefined ? 0 : emissionInterval(conn.requests, conn.perSeconds);
  const tProv =
    prov === undefined ? 0 : emissionInterval(prov.requests, prov.perSeconds);
  const day = statsDay(new Date(now));
  // The pacing state must outlive one full window plus the longest block, or a
  // bucket forgets it was throttled the moment traffic pauses.
  const stateTtlMs = Math.max(
    (conn?.perSeconds ?? 0) * 2000,
    (prov?.perSeconds ?? 0) * 2000,
    policy.maxBlockMs,
    60_000,
  );

  const raw: unknown = await redis.eval(
    GOV_ACQUIRE,
    5,
    rateKey("conn", policy.connectionId),
    rateKey("prov", policy.providerKey),
    semaphoreKey(policy.connectionId),
    statsKey("conn", policy.connectionId, day),
    statsKey("prov", policy.providerKey, day),
    String(now),
    token,
    String(tConn),
    String(tConn * (conn?.burst ?? conn?.requests ?? 0)),
    String(tProv),
    String(tProv * (prov?.burst ?? prov?.requests ?? 0)),
    String(policy.maxConcurrent),
    String(holdMs),
    String(Math.ceil(stateTtlMs)),
    String(STATS_TTL_SECONDS),
  );

  if (!isVerdictTuple(raw)) return { admitted: true, waitMs: 0, reason: "ok" };
  const [admitted, waitMs, reason] = raw;
  return {
    admitted: admitted === 1,
    waitMs: Number(waitMs),
    reason: asReason(reason.toString()),
  };
};

/** Give the seat back. A no-op when the connection has no concurrency cap. */
export const govRelease = async (
  policy: GovernorPolicy,
  token: string,
): Promise<void> => {
  if (policy.maxConcurrent <= 0) return;
  await redis.zrem(semaphoreKey(policy.connectionId), token);
};

/**
 * Hold everyone off this bucket until `untilMs`.
 *
 * Cluster-wide by construction: one caller's 429 is the app telling US to slow
 * down, and letting every other replica discover it independently is how a
 * rate limit turns into a ban.
 */
export const govBlock = async (
  policy: GovernorPolicy,
  scope: "conn" | "prov",
  forMs: number,
  now: number = Date.now(),
): Promise<void> => {
  const bounded = Math.min(Math.max(forMs, 1_000), policy.maxBlockMs);
  const id = scope === "conn" ? policy.connectionId : policy.providerKey;
  await redis.eval(
    GOV_BLOCK,
    2,
    rateKey(scope, id),
    statsKey(scope, id, statsDay(new Date(now))),
    String(now),
    String(now + bounded),
    String(Math.ceil(bounded + 60_000)),
    String(STATS_TTL_SECONDS),
  );
};

export interface GovernorStats {
  calls: number;
  rateLimited: number;
}

/** What this bucket did on `day` — for the connection screen, never a decision. */
export const readGovernorStats = async (
  scope: "conn" | "prov",
  id: string,
  day: string = statsDay(),
): Promise<GovernorStats> => {
  const hash = await redis.hgetall(statsKey(scope, id, day));
  return {
    calls: Number(hash.calls ?? 0),
    rateLimited: Number(hash.rate_limited ?? 0),
  };
};
