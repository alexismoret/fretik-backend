import Redis from "ioredis";

const databaseUrl = process.env.REDIS_URL;
if (!databaseUrl) {
  throw "Missing env var REDIS_URL";
}

export const redis = new Redis(databaseUrl, {
  maxRetriesPerRequest: null,
});

// An ioredis client with no `error` listener rethrows any connection blip as
// an unhandled 'error' event, which crashes the process (and fails unit tests
// that only transitively import this module). Log instead — the client keeps
// retrying under `maxRetriesPerRequest: null`. Mirrors the resumable-stream
// connection diagnostics in @fretik/ai.
redis.on("error", (err: unknown) => {
  console.error(
    "[redis] connection error:",
    err instanceof Error ? err.message : err,
  );
});

/**
 * Whether a freshly computed value is worth storing.
 *
 * The line is at NULLISH, not at falsy, and both sides of it are deliberate.
 *
 * Caching `false` / `0` / `""` is required: they are answers. A lookup that
 * legitimately resolves to one of them would otherwise miss the cache forever
 * — silently, showing up only as load — and the caller's only workaround is to
 * fold the value into an object, which is folklore, not a contract.
 *
 * NOT caching nullish is equally required, and it is why this is not simply
 * "cache everything". Every current caller returns nullish for "not found",
 * and in each one that absence is a decision with a lifetime: `assertOrgAdmin`
 * turns a missing member into a 403, `authMiddleware` turns a missing org or
 * team into a 404, and the registry clients return `null` after a failed HTTP
 * fetch. Storing those would pin a denial, a 404, or a registry outage for the
 * whole TTL — a user added to a team would stay locked out for 30 minutes.
 */
export const isCacheableValue = (value: unknown): boolean =>
  value !== null && value !== undefined;

/**
 * Read `cacheKey` from Redis, or compute it with `fn`, store it and return it.
 *
 * See {@link isCacheableValue} for what does and does not get stored — the one
 * sharp edge of this helper.
 */
export const selectOrCache = async <T>(
  fn: () => Promise<T>,
  cacheKey: string,
  ttl: number = 30 * 60,
): Promise<T> => {
  // `!== null` and not a truthiness test: `get` answers `null` on a miss, and
  // every JSON encoding is a non-empty string (`false` → "false", `0` → "0"),
  // so a truthiness test here would re-compute exactly the values above.
  const value = await redis.get(cacheKey);
  if (value !== null) {
    return JSON.parse(value);
  }

  const newValue = await fn();
  if (isCacheableValue(newValue)) {
    await redis.set(cacheKey, JSON.stringify(newValue), "EX", ttl);
  }

  return newValue;
};

/**
 * Supprime toutes les clés commençant par un préfixe donné de manière performante
 * en utilisant SCAN pour éviter de bloquer l'instance Redis.
 *
 * @param prefix Le préfixe des clés à supprimer
 */
export const deleteKeysByPrefix = async (prefix: string): Promise<void> => {
  const stream = redis.scanStream({
    match: `${prefix}*`,
    count: 100,
  });

  for await (const keys of stream) {
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
};
