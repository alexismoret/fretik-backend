import db from "@fretik/shared/db";
import { aiConversations } from "@fretik/shared/db/schema";
import type { HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { redis } from "@fretik/shared/lib/redis";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

/**
 * Redis-backed per-team rate limiter for `POST /chatbot/stream`.
 *
 * Scope: **per teamId**, not per user nor per IP. Rationale — Fretik
 * bills OpenRouter usage at the team/organization level, so limiting
 * per-team matches the cost surface. A single bavard user saturating
 * his team's limit is acceptable (the team can raise the limit via
 * env var if legitimately needed); ten casual users in the same team
 * sharing the budget is the right default.
 *
 * The team is the CONVERSATION's — the one whose settings and budget the
 * turn runs on (`handlers/chatbot.ts` takes it from the conversation, never
 * from the session) — so a turn in another team's project counts where it
 * costs, and a guest, who has no team of their own, counts against the
 * project that invited them. Only a body naming no conversation of the
 * organization falls back to the session's team, and with neither, to the
 * person: nobody is ever unmetered.
 *
 * Algorithm: sliding-log via Redis ZSET. Mirrors the pattern used by
 * `lib/rate-limit.ts::withSlot` so the Redis usage shape stays
 * consistent across the package. Every request ZADDs a token with
 * the current timestamp as score; on each new request we first drop
 * anything older than `windowMs`, then count live entries. Over cap
 * → 429 + `Retry-After`.
 *
 * Why not INCR+EXPIRE:
 *   - Fixed-window INCR has a burst problem at window boundaries
 *     (20 req in the last ms of window N + 20 req in the first ms of
 *     window N+1 = 40 req in 2ms, worst case).
 *   - Sliding-log is precise and the cost (one ZREMRANGEBYSCORE + one
 *     ZCARD + one ZADD per request) is negligible at our traffic scale.
 *
 * Scope exclusions:
 *   - `/internal/invoke` is NOT rate-limited — it's an authenticated
 *     service-to-service endpoint and the callers (api, worker) are
 *     trusted by design.
 */

const DEFAULT_LIMIT_PER_MIN = 20;
const WINDOW_MS = 60_000;

const resolveLimit = (): number => {
  const raw = process.env.AI_CHATBOT_RATE_LIMIT_PER_MIN;
  if (!raw) return DEFAULT_LIMIT_PER_MIN;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT_PER_MIN;
  return Math.floor(parsed);
};

const LIMIT_PER_MIN = resolveLimit();

const streamBodySchema = z.looseObject({ conversationId: z.uuid() });

/**
 * The bucket a turn counts in: its conversation's team, else the session's
 * team, else the person. Reading the body here costs nothing more: Hono
 * keeps it for the handler's own `c.req.json()`.
 */
const bucketOf = async (c: Context<HonoLoggedAppType>): Promise<string> => {
  const body = streamBodySchema.safeParse(
    await c.req.json().catch((): unknown => null),
  );
  if (body.success) {
    const [row] = await db
      .select({ teamId: aiConversations.teamId })
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.id, body.data.conversationId),
          eq(aiConversations.organizationId, c.get("principal").organizationId),
        ),
      );
    if (row) return `chatbot:rate:${row.teamId}`;
  }
  const team = c.get("team");
  return team
    ? `chatbot:rate:${team.id}`
    : `chatbot:rate:user:${c.get("user").id}`;
};

const makeToken = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Estimate the number of seconds until the oldest in-window request
 * leaves the window. Used for the `Retry-After` header when the
 * client hits the cap.
 */
const computeRetryAfterSeconds = async (
  key: string,
  windowMs: number,
): Promise<number> => {
  // ZRANGE ... WITHSCORES 0 0 → oldest entry + its score (the ts).
  const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
  if (oldest.length < 2) return 1;
  const oldestScore = Number(oldest[1]);
  if (!Number.isFinite(oldestScore)) return 1;
  const msUntilFree = oldestScore + windowMs - Date.now();
  return Math.max(1, Math.ceil(msUntilFree / 1000));
};

export const chatbotRateLimitMiddleware = createMiddleware<HonoLoggedAppType>(
  async (c, next) => {
    const key = await bucketOf(c);
    const now = Date.now();
    const staleCutoff = now - WINDOW_MS;

    // Drop expired entries first so the count reflects only the current
    // sliding window.
    await redis.zremrangebyscore(key, "-inf", staleCutoff);

    const liveCount = await redis.zcard(key);
    if (liveCount >= LIMIT_PER_MIN) {
      const retryAfter = await computeRetryAfterSeconds(key, WINDOW_MS);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          code: "RATE_LIMIT_EXCEEDED",
          message: `Chatbot rate limit reached (${LIMIT_PER_MIN} req/min per team). Retry in ${retryAfter}s.`,
          retryAfter,
        },
        429,
      );
    }

    // Under cap — register this request.
    await redis.zadd(key, now, makeToken());
    // Belt-and-suspenders TTL: if the team stops sending, the whole
    // key disappears after 2× the window instead of lingering as an
    // empty ZSET. Refreshing on every request is fine.
    await redis.pexpire(key, WINDOW_MS * 2);

    return next();
  },
);
