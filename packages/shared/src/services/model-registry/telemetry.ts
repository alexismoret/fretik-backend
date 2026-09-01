import { and, desc, gte, sql } from "drizzle-orm";
import db from "../../db";
import { modelTelemetryRollups } from "../../db/schema/model-registry";
import { redis } from "../../lib/redis";
import { normalizeProviderName } from "../../model-registry/provider-names";
import type { TransportId } from "../../model-registry/types";

/**
 * What our own traffic knows about the upstreams we route to.
 *
 * The registry grades models on figures the vendors publish about themselves:
 * a throughput aggregated over everyone's traffic, a latency measured from
 * somewhere else, an uptime nobody can audit. It is a reasonable default and
 * it is second-hand — and on 2026-09-01 it turned out to be worse than that,
 * because a lapsed credential made the whole fleet's percentiles vanish while
 * every dashboard still said `ok`.
 *
 * Meanwhile every real call already passes through one middleware that sees
 * which host served it, how fast it decoded, what it cost and whether it
 * finished. None of it was written down. This module is that sink, and the
 * rule it exists to enforce is simple: WHAT WE MEASURED OURSELVES OUTRANKS
 * WHAT WE WERE TOLD, when we have enough of it to mean something.
 *
 * ## Two stages, and why
 *
 * Calls land in REDIS: a counter hash plus a bounded sample reservoir, per
 * (model, upstream, transport, hour), 48 h TTL. An hourly job folds each
 * closed bucket into `model_telemetry_rollups` and deletes it.
 *
 * Postgres cannot be the first stop. This fires on every LLM request —
 * 10^4-10^6 a day — and the questions it answers are all aggregate, so a row
 * per call would be a hot-path insert buying nothing a counter cannot give.
 * Redis cannot be the last stop either: it is a 48-hour cache that may be
 * flushed, and a policy that reads a week of history needs somewhere durable.
 *
 * ## Never at the expense of a turn
 *
 * `recordCall` swallows everything. A Redis outage must be invisible to the
 * person waiting on their answer: losing an hour of telemetry costs the
 * registry a little evidence, while a failed write propagating into a stream
 * costs a customer their reply. Callers still `void`-and-`catch` it, because
 * defence in depth on the hot path is cheap.
 */

/** Key prefix, versioned: a shape change must not read old buckets as new ones. */
const KEY_PREFIX = "model-telemetry:v1";

/**
 * Samples kept per bucket for the percentiles.
 *
 * A reservoir rather than every value: an upstream serving 50 000 calls in an
 * hour would otherwise hold a 50 000-element list to answer two percentiles.
 * 512 is far past the point where a p50 or p95 stops moving, and it bounds the
 * memory a single busy hour can take.
 */
export const TELEMETRY_SAMPLE_CAP = 512;

/** Buckets outlive their rollup by a day, so a job that missed an hour can still catch it. */
const BUCKET_TTL_SECONDS = 48 * 60 * 60;

/**
 * Observations required before the policy will prefer our figures to a
 * catalogue's. A p95 over four calls is not a p95, and letting one unlucky
 * afternoon override a vendor's 30-day aggregate would make the grading
 * noisier than the thing it replaced.
 */
export const TELEMETRY_MIN_SAMPLES = 50;

/**
 * How far back a measurement still counts. Upstreams requantise, move hardware
 * and reprice; a month-old decode rate describes a service that may no longer
 * exist, and presenting it beside a fresh one gives it authority it lost.
 */
export const TELEMETRY_FRESH_DAYS = 7;

/** The hour a timestamp falls in, UTC — the bucket boundary. */
export const bucketStartFor = (at: Date): Date =>
  new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      at.getUTCHours(),
    ),
  );

const bucketKey = (
  profileKey: string,
  provider: string,
  transport: TransportId,
  bucketStart: Date,
): string =>
  `${KEY_PREFIX}:${profileKey}:${provider}:${transport}:${bucketStart.toISOString()}`;

export interface CallMeasurement {
  profileKey: string;
  /** The upstream that ACTUALLY served, normalised — never the model id. */
  provider: string;
  transport: TransportId;
  /** Wall clock for the whole call, milliseconds. */
  durationMs: number;
  /**
   * Time to the first token, milliseconds. Streaming only: a non-streamed call
   * has no first token to observe, and recording its total duration here would
   * quietly turn a latency percentile into a length percentile.
   */
  ttftMs?: number;
  outputTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  /** The call ended on something nobody chose — a cut, a refusal, a throw. */
  errored?: boolean;
  at?: Date;
}

/**
 * Decode rate for one call, or `undefined` when it cannot be honestly derived.
 *
 * TTFT is SUBTRACTED where we have it: waiting on a queue is not slow decoding,
 * and including it would rank a host with a cold start below one that is
 * genuinely slower per token. Very short calls are dropped rather than
 * measured — a 3-token answer in 40 ms yields a rate the arithmetic supports
 * and the reality does not.
 */
const decodeRate = (measurement: CallMeasurement): number | undefined => {
  const { outputTokens, durationMs, ttftMs } = measurement;
  if (outputTokens === undefined || outputTokens < 16) return undefined;
  const decodeMs = durationMs - (ttftMs ?? 0);
  if (decodeMs < 200) return undefined;
  return (outputTokens / decodeMs) * 1000;
};

/**
 * Fold one finished call into its bucket. Never throws, never awaited on a
 * turn's critical path.
 *
 * One pipeline, so a call costs one round trip regardless of how many fields
 * it carries. `LTRIM` after each `LPUSH` keeps the reservoirs bounded at write
 * time rather than trusting a reader to cope.
 */
export const recordCall = async (
  measurement: CallMeasurement,
): Promise<void> => {
  try {
    const at = measurement.at ?? new Date();
    const provider = normalizeProviderName(measurement.provider);
    const key = bucketKey(
      measurement.profileKey,
      provider,
      measurement.transport,
      bucketStartFor(at),
    );

    const pipeline = redis.pipeline();
    pipeline.hincrby(key, "calls", 1);
    if (measurement.errored === true) pipeline.hincrby(key, "errors", 1);
    if (measurement.outputTokens !== undefined) {
      pipeline.hincrby(key, "outputTokens", measurement.outputTokens);
    }
    if (measurement.inputTokens !== undefined) {
      pipeline.hincrby(key, "inputTokens", measurement.inputTokens);
    }
    if (measurement.cachedInputTokens !== undefined) {
      pipeline.hincrby(key, "cachedInputTokens", measurement.cachedInputTokens);
    }
    if (measurement.costUsd !== undefined) {
      // Integer micro-USD: `HINCRBY` cannot take a float, and summing floats
      // over millions of calls drifts anyway.
      pipeline.hincrby(
        key,
        "costMicroUsd",
        Math.round(measurement.costUsd * 1e6),
      );
    }

    const tps = decodeRate(measurement);
    if (tps !== undefined) {
      pipeline.lpush(`${key}:tps`, tps.toFixed(2));
      pipeline.ltrim(`${key}:tps`, 0, TELEMETRY_SAMPLE_CAP - 1);
      pipeline.expire(`${key}:tps`, BUCKET_TTL_SECONDS);
    }
    if (measurement.ttftMs !== undefined) {
      pipeline.lpush(`${key}:ttft`, Math.round(measurement.ttftMs).toString());
      pipeline.ltrim(`${key}:ttft`, 0, TELEMETRY_SAMPLE_CAP - 1);
      pipeline.expire(`${key}:ttft`, BUCKET_TTL_SECONDS);
    }
    pipeline.expire(key, BUCKET_TTL_SECONDS);
    await pipeline.exec();
  } catch (err: unknown) {
    // Deliberately swallowed. See the header: an observability write may never
    // be the reason a customer's answer fails.
    console.warn(
      "[model-telemetry] dropped a measurement:",
      err instanceof Error ? err.message : err,
    );
  }
};

export interface TelemetryWindow {
  provider: string;
  transport: TransportId;
  calls: number;
  errors: number;
  tpsP50?: number;
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  sampleCount: number;
  /** Most recent bucket in the window — how current this evidence is. */
  latestBucket: Date;
}

/**
 * Our measurements for one model over the freshness window, per upstream.
 *
 * Weighted by `sampleCount` rather than averaged flat: an hour with 400 calls
 * says more about a host than one with 3, and treating them equally lets a
 * quiet night outvote a busy day.
 */
export const readTelemetryWindow = async (
  profileKey: string,
  options?: { since?: Date; now?: Date },
): Promise<TelemetryWindow[]> => {
  const now = options?.now ?? new Date();
  const since =
    options?.since ??
    new Date(now.getTime() - TELEMETRY_FRESH_DAYS * 24 * 60 * 60_000);

  const rows = await db
    .select({
      provider: modelTelemetryRollups.provider,
      transport: modelTelemetryRollups.transport,
      calls: sql<number>`sum(${modelTelemetryRollups.calls})::int`,
      errors: sql<number>`sum(${modelTelemetryRollups.errors})::int`,
      sampleCount: sql<number>`sum(${modelTelemetryRollups.sampleCount})::int`,
      // Sample-weighted means of the per-hour percentiles. Not a true
      // percentile over the union — that would need the raw samples, which are
      // deliberately not kept — but a defensible summary of measured hours,
      // and far closer to the truth than an unweighted average.
      tpsP50: sql<
        number | null
      >`sum(${modelTelemetryRollups.tpsP50} * ${modelTelemetryRollups.sampleCount}) / nullif(sum(case when ${modelTelemetryRollups.tpsP50} is null then 0 else ${modelTelemetryRollups.sampleCount} end), 0)`,
      ttftP50Ms: sql<
        number | null
      >`sum(${modelTelemetryRollups.ttftP50Ms} * ${modelTelemetryRollups.sampleCount}) / nullif(sum(case when ${modelTelemetryRollups.ttftP50Ms} is null then 0 else ${modelTelemetryRollups.sampleCount} end), 0)`,
      ttftP95Ms: sql<number | null>`max(${modelTelemetryRollups.ttftP95Ms})`,
      latestBucket: sql<Date>`max(${modelTelemetryRollups.bucketStart})`,
    })
    .from(modelTelemetryRollups)
    .where(
      and(
        sql`${modelTelemetryRollups.profileKey} = ${profileKey}`,
        gte(modelTelemetryRollups.bucketStart, since),
      ),
    )
    .groupBy(modelTelemetryRollups.provider, modelTelemetryRollups.transport)
    .orderBy(desc(sql`sum(${modelTelemetryRollups.calls})`));

  return rows.map((row) => ({
    provider: row.provider,
    transport: row.transport,
    calls: row.calls,
    errors: row.errors,
    sampleCount: row.sampleCount,
    ...(row.tpsP50 === null ? {} : { tpsP50: row.tpsP50 }),
    ...(row.ttftP50Ms === null ? {} : { ttftP50Ms: row.ttftP50Ms }),
    ...(row.ttftP95Ms === null ? {} : { ttftP95Ms: row.ttftP95Ms }),
    latestBucket: new Date(row.latestBucket),
  }));
};

/**
 * Measured figures keyed by upstream, for the policy to prefer over the
 * catalogue's. Only upstreams with enough observations are returned: below
 * `TELEMETRY_MIN_SAMPLES` the honest answer is "we do not know yet", and the
 * caller falls back to what the vendor published rather than to noise.
 */
export const readMeasuredEndpointStats = async (
  profileKey: string,
  options?: { now?: Date },
): Promise<Map<string, { throughputP50?: number; latencyP50Ms?: number }>> => {
  const measured = new Map<
    string,
    { throughputP50?: number; latencyP50Ms?: number }
  >();
  const windows = await readTelemetryWindow(profileKey, options);
  for (const window of windows) {
    if (window.sampleCount < TELEMETRY_MIN_SAMPLES) continue;
    measured.set(window.provider, {
      ...(window.tpsP50 === undefined ? {} : { throughputP50: window.tpsP50 }),
      ...(window.ttftP50Ms === undefined
        ? {}
        : { latencyP50Ms: window.ttftP50Ms }),
    });
  }
  return measured;
};
