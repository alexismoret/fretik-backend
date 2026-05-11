import Redis from "ioredis";

const databaseUrl = process.env.REDIS_URL;
if (!databaseUrl) {
  throw "Missing env var REDIS_URL";
}

export const redis = new Redis(databaseUrl, {
  maxRetriesPerRequest: null,
});

/**
 * If in redis, return data else Select from fn, set in cache and return
 *
 * @param fn
 * @param cacheKey
 * @param ttl
 * @returns
 */
export const selectOrCache = async <T>(
  fn: () => Promise<T>,
  cacheKey: string,
  ttl: number = 30 * 60,
): Promise<T> => {
  const value = await redis.get(cacheKey);
  if (value) {
    return JSON.parse(value);
  }

  const newValue = await fn();
  if (newValue) {
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
