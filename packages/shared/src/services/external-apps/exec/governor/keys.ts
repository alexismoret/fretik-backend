/**
 * Every Redis key the outgoing-call governor owns, in one file.
 *
 * The `gov:` prefix is free: this deployment already uses `lock:`, `rl:`,
 * `ratelimit:`, `chatbot:rate:`, `page:` and `e2b:`, and none of them is a
 * prefix of this one. That matters more than it looks — `deleteKeysByPrefix`
 * exists and is called with hand-written prefixes, so a namespace that overlaps
 * another is a flush waiting to take out the wrong thing.
 *
 * The state is deliberately tiny and deliberately not authoritative: a flushed
 * Redis costs one window of over-permission, never a lost call or a wrong
 * answer. That is what lets the governor fail open.
 */

/**
 * The pacing state for one bucket — a hash with two fields:
 *  - `tat`, the GCRA theoretical arrival time (see `lua.ts`);
 *  - `blocked_until`, when a 429 anybody hit stops applying.
 */
export const rateKey = (scope: "conn" | "prov", id: string): string =>
  `gov:rl:${scope}:${id}`;

/** In-flight holds on one connection, as a ZSET of token → acquired-at. */
export const semaphoreKey = (connectionId: string): string =>
  `gov:sem:conn:${connectionId}`;

/**
 * What this bucket did today — `calls` and `rate_limited`, in a hash that
 * expires on its own. It is there so the connection screen can say "1 204 calls
 * today, 3 refused" instead of asking the operator to trust a number nobody
 * counts, and so a 429 leaves a trace even when the retry succeeds.
 */
export const statsKey = (
  scope: "conn" | "prov",
  id: string,
  day: string,
): string => `gov:stats:${scope}:${id}:${day}`;

/** `YYYY-MM-DD` in UTC — the day a stats bucket belongs to. */
export const statsDay = (at: Date = new Date()): string =>
  at.toISOString().slice(0, 10);
