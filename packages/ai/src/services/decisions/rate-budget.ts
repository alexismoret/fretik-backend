import { redis } from "@fretik/shared/lib/redis";

/**
 * A per-minute ceiling on decision calls, shared by every replica.
 *
 * The provider allows 1 200 requests a minute. A nightly consolidation burst
 * or a bulk upload matched against many workflows could spend that in
 * seconds, and a 429 storm is the worst way to learn it: every call in it
 * falls open at once. So the budget is ours, counted in Redis, and it refuses
 * BACKGROUND work first — a background decision that is refused simply runs
 * the path it would have replaced, while a hot-path one is a user waiting.
 *
 * Fails OPEN on a Redis error. The budget is a courtesy to the provider, not
 * a safety property, and a Redis blip must not switch decisions off.
 *
 * A constant, not a setting: the provider's limit is the account's, and the
 * margin under it is a choice made once, here.
 */
const RPM = 1_000;

/** Background points stop at this share of the budget; hot ones use it all. */
const BACKGROUND_SHARE = 0.8;

export const takeRateBudget = async (
  calls: number,
  path: "hot" | "background",
): Promise<boolean> => {
  if (calls <= 0) return true;
  const key = `decisions:rpm:${Math.floor(Date.now() / 60_000).toString()}`;
  try {
    const replies = await redis
      .multi()
      .incrby(key, calls)
      .expire(key, 120)
      .exec();
    const total = replies?.[0]?.[1];
    const used = typeof total === "number" ? total : 0;
    const ceiling = path === "hot" ? RPM : Math.floor(RPM * BACKGROUND_SHARE);
    return used <= ceiling;
  } catch {
    return true;
  }
};
