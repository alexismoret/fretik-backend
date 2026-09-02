/**
 * In-memory stand-in for the shared ioredis singleton.
 *
 * Registered from `tests/preload.ts` rather than from a test file: the real
 * client is imported by dozens of modules, so whichever file loads first wins
 * the module cache, and a per-file `mock.module` is execution-order dependent
 * (the failure mode this suite has already been bitten by twice).
 *
 * It exists because unit tests must not need a server, and the alternative —
 * pointing `REDIS_URL` at a dead port — does not fail, it HANGS: ioredis
 * retries forever and the test dies on the 5 s timeout instead of asserting.
 *
 * Deliberately NOT a full Redis. It implements the commands the code under
 * test actually issues, and every other command throws by name. A loud,
 * specific failure is what you want the day someone reaches for `pipeline` or
 * `xrange`: a silent `undefined` would turn a real assertion into a passing
 * lie.
 */

type Entry =
  | { value: string }
  | { hash: Map<string, string> }
  | { set: Set<string> }
  | { zset: Map<string, number> };

const store = new Map<string, Entry>();

const asValue = (key: string): string | null => {
  const e = store.get(key);
  return e && "value" in e ? e.value : null;
};

const hashAt = (key: string): Map<string, string> => {
  const e = store.get(key);
  if (e && "hash" in e) return e.hash;
  const hash = new Map<string, string>();
  store.set(key, { hash });
  return hash;
};

const setAt = (key: string): Set<string> => {
  const e = store.get(key);
  if (e && "set" in e) return e.set;
  const set = new Set<string>();
  store.set(key, { set });
  return set;
};

const zsetAt = (key: string): Map<string, number> => {
  const e = store.get(key);
  if (e && "zset" in e) return e.zset;
  const zset = new Map<string, number>();
  store.set(key, { zset });
  return zset;
};

/** `-inf` / `+inf` / a numeric string, as ioredis accepts them. */
const asScore = (bound: number | string): number => {
  if (typeof bound === "number") return bound;
  if (bound === "-inf") return Number.NEGATIVE_INFINITY;
  if (bound === "+inf" || bound === "inf") return Number.POSITIVE_INFINITY;
  return Number.parseFloat(bound);
};

const notImplemented = (name: string) => (): never => {
  throw new Error(
    `[redis-double] \`${name}\` is not implemented. Add it to tests/lib/redis-double.ts if the code under test needs it — do not point tests at a real Redis.`,
  );
};

export const redisDouble = {
  // --- strings / counters ---
  get: (key: string): Promise<string | null> => Promise.resolve(asValue(key)),
  set: (key: string, value: string): Promise<"OK"> => {
    store.set(key, { value: String(value) });
    return Promise.resolve("OK");
  },
  setex: (key: string, _ttl: number, value: string): Promise<"OK"> => {
    store.set(key, { value: String(value) });
    return Promise.resolve("OK");
  },
  getdel: (key: string): Promise<string | null> => {
    const v = asValue(key);
    store.delete(key);
    return Promise.resolve(v);
  },
  incr: (key: string): Promise<number> => {
    const next = Number.parseInt(asValue(key) ?? "0", 10) + 1;
    store.set(key, { value: String(next) });
    return Promise.resolve(next);
  },
  decr: (key: string): Promise<number> => {
    const next = Number.parseInt(asValue(key) ?? "0", 10) - 1;
    store.set(key, { value: String(next) });
    return Promise.resolve(next);
  },
  mget: (...keys: string[]): Promise<(string | null)[]> =>
    Promise.resolve(keys.flat().map((k) => asValue(k))),

  // --- hashes ---
  hset: (key: string, fields: Record<string, string>): Promise<number> => {
    const hash = hashAt(key);
    for (const [f, v] of Object.entries(fields)) hash.set(f, String(v));
    return Promise.resolve(Object.keys(fields).length);
  },
  hgetall: (key: string): Promise<Record<string, string>> => {
    const e = store.get(key);
    return Promise.resolve(e && "hash" in e ? Object.fromEntries(e.hash) : {});
  },

  // --- sets ---
  sadd: (key: string, ...members: string[]): Promise<number> => {
    const set = setAt(key);
    const before = set.size;
    for (const m of members.flat()) set.add(String(m));
    return Promise.resolve(set.size - before);
  },
  smembers: (key: string): Promise<string[]> => {
    const e = store.get(key);
    return Promise.resolve(e && "set" in e ? [...e.set] : []);
  },

  // --- sorted sets ---
  // Implemented for real, because `lib/rate-limit.ts` is a CONCURRENCY
  // SEMAPHORE built out of them: it drops stale members by score, claims a
  // slot, counts, and gives the slot back when it is over cap. A stub that
  // answered 0 or `undefined` would hand out unlimited slots and the limiter's
  // tests would pass against a limiter that does not limit. Every embedding
  // path in the suite goes through this.
  zadd: (key: string, score: number, member: string): Promise<number> => {
    const zset = zsetAt(key);
    const isNew = !zset.has(member);
    zset.set(member, score);
    return Promise.resolve(isNew ? 1 : 0);
  },
  zcard: (key: string): Promise<number> => {
    const e = store.get(key);
    return Promise.resolve(e && "zset" in e ? e.zset.size : 0);
  },
  zrem: (key: string, ...members: string[]): Promise<number> => {
    const e = store.get(key);
    if (!e || !("zset" in e)) return Promise.resolve(0);
    let removed = 0;
    for (const m of members.flat()) if (e.zset.delete(String(m))) removed += 1;
    return Promise.resolve(removed);
  },
  zremrangebyscore: (
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> => {
    const e = store.get(key);
    if (!e || !("zset" in e)) return Promise.resolve(0);
    const lo = asScore(min);
    const hi = asScore(max);
    let removed = 0;
    for (const [member, score] of [...e.zset]) {
      if (score >= lo && score <= hi) {
        e.zset.delete(member);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  },
  zrange: (key: string, start: number, stop: number): Promise<string[]> => {
    const e = store.get(key);
    if (!e || !("zset" in e)) return Promise.resolve([]);
    const ordered = [...e.zset]
      .sort(([, a], [, b]) => a - b)
      .map(([member]) => member);
    const end = stop < 0 ? ordered.length + stop + 1 : stop + 1;
    return Promise.resolve(ordered.slice(start, end));
  },

  // --- keyspace ---
  del: (...keys: string[]): Promise<number> => {
    let n = 0;
    for (const k of keys.flat()) if (store.delete(k)) n += 1;
    return Promise.resolve(n);
  },
  // TTLs are no-ops: nothing in the unit suite asserts expiry, and a fake
  // clock would be a second source of truth for time.
  expire: (): Promise<number> => Promise.resolve(1),
  pexpire: (): Promise<number> => Promise.resolve(1),
  pttl: (): Promise<number> => Promise.resolve(-1),

  // --- explicitly unsupported ---
  on: (): unknown => redisDouble,
  duplicate: (): unknown => redisDouble,
  pipeline: notImplemented("pipeline"),
  eval: notImplemented("eval"),
  call: notImplemented("call"),
  scan: notImplemented("scan"),
  scanStream: notImplemented("scanStream"),
  publish: notImplemented("publish"),
  xrange: notImplemented("xrange"),
  xrevrange: notImplemented("xrevrange"),
  getBuffer: notImplemented("getBuffer"),
  mgetBuffer: notImplemented("mgetBuffer"),
};

/** Drop every key — call from `beforeEach` when a test needs a clean store. */
export const resetRedisDouble = (): void => {
  store.clear();
};
