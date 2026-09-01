import { lt } from "drizzle-orm";
import db from "../../db";
import { modelTelemetryRollups } from "../../db/schema/model-registry";
import { redis } from "../../lib/redis";
import { isTransportId } from "../../model-registry/types";

/**
 * Fold closed Redis buckets into `model_telemetry_rollups`.
 *
 * The counters live in Redis because writing a Postgres row per LLM call would
 * put 10^4-10^6 inserts a day on the hot path to answer questions that are all
 * aggregate. They cannot STAY there: a 48-hour cache that may be flushed is no
 * place for the evidence a grading policy reads a week of.
 *
 * Only CLOSED buckets are folded. An hour still receiving calls would be
 * written half-formed and then either duplicated or silently frozen at whatever
 * it held when the job ran — both worse than waiting sixty minutes.
 *
 * Idempotent by construction: a bucket is DELETED once written, so a job that
 * runs twice, or catches up after a missed hour, cannot double-count. Deleting
 * after the insert rather than before is the deliberate direction — a crash
 * between the two re-folds one bucket on the next pass, which shows up as a
 * duplicate row for one hour, while the other order loses the hour entirely.
 */

const KEY_PREFIX = "model-telemetry:v1";

/**
 * Buckets kept in Postgres. Long enough to see a seasonal pattern or argue
 * about a regression that started three weeks ago; short enough that the table
 * stays small on a fleet of 100+ models times a dozen upstreams times 24 hours.
 */
export const TELEMETRY_RETENTION_DAYS = 60;

/** Percentile from an unsorted sample list, nearest-rank. `undefined` on empty. */
export const percentile = (
  values: readonly number[],
  fraction: number,
): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
};

/** `model-telemetry:v1:{profileKey}:{provider}:{transport}:{iso}` — parsed back, or `undefined`. */
const parseKey = (
  key: string,
):
  | {
      profileKey: string;
      provider: string;
      transport: string;
      bucketStart: Date;
    }
  | undefined => {
  const rest = key.slice(`${KEY_PREFIX}:`.length);
  // The ISO stamp is the LAST segment and contains colons of its own, so the
  // split is bounded from the left and the remainder is the stamp.
  const parts = rest.split(":");
  if (parts.length < 4) return undefined;
  const [profileKey, provider, transport, ...stamp] = parts;
  if (
    profileKey === undefined ||
    provider === undefined ||
    transport === undefined
  ) {
    return undefined;
  }
  const bucketStart = new Date(stamp.join(":"));
  if (Number.isNaN(bucketStart.getTime())) return undefined;
  return { profileKey, provider, transport, bucketStart };
};

const toInt = (value: string | undefined): number =>
  value === undefined ? 0 : Number.parseInt(value, 10) || 0;

export interface TelemetryRollupStats {
  bucketsFolded: number;
  rowsWritten: number;
  rowsPurged: number;
  errors: string[];
}

/**
 * One rollup pass. Returns what it did, so the worker can log a line an
 * operator can act on rather than "done".
 */
export const runTelemetryRollup = async (options?: {
  now?: Date;
}): Promise<TelemetryRollupStats> => {
  const now = options?.now ?? new Date();
  const stats: TelemetryRollupStats = {
    bucketsFolded: 0,
    rowsWritten: 0,
    rowsPurged: 0,
    errors: [],
  };

  // `SCAN`, never `KEYS`: this runs against the same Redis the chat turns use,
  // and `KEYS` blocks the server for the length of the keyspace.
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      `${KEY_PREFIX}:*`,
      "COUNT",
      500,
    );
    cursor = next;
    // The sample reservoirs are children of a bucket key; folding them as
    // buckets in their own right would parse garbage and write empty rows.
    for (const key of batch) {
      if (!key.endsWith(":tps") && !key.endsWith(":ttft")) keys.push(key);
    }
  } while (cursor !== "0");

  const openBucket = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    ),
  );

  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed === undefined || !isTransportId(parsed.transport)) {
      stats.errors.push(`unparseable telemetry key ${key}`);
      continue;
    }
    // Still filling: leave it for the next pass.
    if (parsed.bucketStart.getTime() >= openBucket.getTime()) continue;

    try {
      const [counters, tpsSamples, ttftSamples] = await Promise.all([
        redis.hgetall(key),
        redis.lrange(`${key}:tps`, 0, -1),
        redis.lrange(`${key}:ttft`, 0, -1),
      ]);
      const calls = toInt(counters.calls);
      if (calls === 0) {
        await redis.del(key, `${key}:tps`, `${key}:ttft`);
        continue;
      }

      const tps = tpsSamples.map(Number).filter(Number.isFinite);
      const ttft = ttftSamples.map(Number).filter(Number.isFinite);
      const inputTokens = toInt(counters.inputTokens);
      const cachedInputTokens = toInt(counters.cachedInputTokens);

      await db.insert(modelTelemetryRollups).values({
        profileKey: parsed.profileKey,
        provider: parsed.provider,
        transport: parsed.transport,
        bucketStart: parsed.bucketStart,
        calls,
        errors: toInt(counters.errors),
        tpsP50: percentile(tps, 0.5) ?? null,
        tpsP95: percentile(tps, 0.95) ?? null,
        ttftP50Ms: percentile(ttft, 0.5) ?? null,
        ttftP95Ms: percentile(ttft, 0.95) ?? null,
        costMicroUsd: toInt(counters.costMicroUsd),
        // Only when the transport reported input tokens at all: a zero
        // denominator is "not reported", and writing 0 would read as "this
        // host never caches" — a claim about the host rather than about us.
        cacheReadRatio:
          inputTokens > 0 ? cachedInputTokens / inputTokens : null,
        sampleCount: Math.max(tps.length, ttft.length),
      });
      stats.rowsWritten += 1;
      stats.bucketsFolded += 1;
      // Only after the row landed — see the header on the crash direction.
      await redis.del(key, `${key}:tps`, `${key}:ttft`);
    } catch (err: unknown) {
      stats.errors.push(
        `${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    const purged = await db
      .delete(modelTelemetryRollups)
      .where(
        lt(
          modelTelemetryRollups.bucketStart,
          new Date(now.getTime() - TELEMETRY_RETENTION_DAYS * 24 * 60 * 60_000),
        ),
      )
      .returning({ id: modelTelemetryRollups.id });
    stats.rowsPurged = purged.length;
  } catch (err: unknown) {
    stats.errors.push(
      `retention purge: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return stats;
};
