import type { Context } from "hono";
import { rateLimiter, type Store } from "hono-rate-limiter";
import { redis } from "./redis";

/** Best-effort client IP behind a proxy (Traefik / Vercel set
 * `x-forwarded-for`); falls back to `x-real-ip`, then a constant so a missing
 * header buckets together rather than throwing. */
export const clientIp = (c: Context): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  c.req.header("x-real-ip") ??
  "unknown";

type InitOptions = Parameters<NonNullable<Store["init"]>>[0];

/**
 * `hono-rate-limiter` Store backed by the shared ioredis connection, so the
 * counters are shared across every horizontally/vertically scaled instance
 * (the built-in MemoryStore is per-process and the official Redis store is
 * Upstash-only). Fixed-window counter: `INCR` the key and set its TTL on the
 * first hit of the window.
 */
class RedisRateLimitStore implements Store {
  prefix: string;
  localKeys = false;
  private windowMs = 60_000;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: InitOptions): void {
    this.windowMs = options.windowMs;
  }

  private redisKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async increment(
    key: string,
  ): Promise<{ totalHits: number; resetTime: Date }> {
    const rk = this.redisKey(key);
    const totalHits = await redis.incr(rk);
    let ttl = await redis.pttl(rk);
    // First hit of the window (or a key that somehow lost its expiry) → arm it.
    if (totalHits === 1 || ttl < 0) {
      await redis.pexpire(rk, this.windowMs);
      ttl = this.windowMs;
    }
    return { totalHits, resetTime: new Date(Date.now() + ttl) };
  }

  async decrement(key: string): Promise<void> {
    await redis.decr(this.redisKey(key));
  }

  async resetKey(key: string): Promise<void> {
    await redis.del(this.redisKey(key));
  }
}

/** A Redis-backed rate-limit store scoped by `prefix` (one per limiter so their
 * counters never collide). */
export const createRedisRateLimitStore = (prefix: string): Store =>
  new RedisRateLimitStore(prefix);

const parseGlobalLimit = (): number => {
  const raw = process.env.GLOBAL_RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || raw === "") return 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
};
const GLOBAL_LIMIT_PER_MINUTE = parseGlobalLimit();

/**
 * Broad per-IP anti-abuse backstop for a whole HTTP service (API / AI). Wide on
 * purpose — it never throttles a legitimate user or a normal caller, only trips
 * on runaway scraping / floods. Service-to-service traffic is exempt by PATH
 * (`/internal/*`, `/health`), never by a client-supplied header (that would be a
 * trivial bypass). Better Auth keeps its own tighter limiter on `/auth/*`, so
 * this sits above it as a coarse ceiling. Redis-backed → shared across
 * instances. `GLOBAL_RATE_LIMIT_PER_MINUTE` tunes the cap.
 */
export const globalRateLimiter = () =>
  rateLimiter({
    windowMs: 60_000,
    limit: GLOBAL_LIMIT_PER_MINUTE,
    standardHeaders: "draft-6",
    keyGenerator: clientIp,
    skip: (c) => {
      const path = c.req.path;
      return path === "/health" || path.startsWith("/internal");
    },
    store: createRedisRateLimitStore("rl:global:"),
    requestPropertyName: "rateLimitGlobal",
  });
