import { and, desc, eq, gte } from "drizzle-orm";
import db from "../../db";
import { modelBenchRuns } from "../../db/schema/model-registry";
import type { TransportId } from "../../model-registry/types";

/**
 * Persisting what `models:bench` measured.
 *
 * The bench answers the one question no catalogue does — which of the hosts
 * that CAN serve a model deserve to be in its pool — and until now it answered
 * it to a terminal. `model_bench_runs` existed, `models:admin scorecard` read
 * it, and nothing ever wrote a row: the scorecard's bench section had been
 * empty since the table was created, and the CLI help advertised a `--save`
 * flag that was never implemented.
 *
 * That is worse than having no table, because a reader takes an empty section
 * to mean "measured, nothing notable" rather than "never measured". Writing
 * here closes that, and it is the prerequisite for ever running the bench on a
 * schedule: a measurement nobody can read afterwards cannot inform a decision
 * taken later, by a person or by a job.
 *
 * One row per (profile, upstream, run). Nothing is updated or de-duplicated —
 * the value of these rows is the SERIES: an upstream that regressed is only
 * visible against what it used to do, which is precisely what the numbers
 * living in source comments could never show.
 */

/** What the bench measured for ONE upstream. Absent means "not measured". */
export interface BenchMeasurement {
  /** Normalised upstream name — the same key a quarantine uses. */
  provider: string;
  tokensPerSecondMedian?: number;
  tokensPerSecondBest?: number;
  /**
   * Integrity-gate passes out of `intactTotal`. The column that decides pool
   * membership: an upstream that truncates answers ending in a tool call is
   * unusable at any speed, and every agent turn ends in a tool call.
   */
  intactPassed?: number;
  intactTotal?: number;
  coldCostUsd?: number;
  warmCostUsd?: number;
  reasoningTokens?: number;
  http429Count?: number;
  failures?: number;
  note?: string;
}

export interface RecordBenchRunsInput {
  profileKey: string;
  /** The transport the measurement was taken THROUGH, never the row's. */
  transport: TransportId;
  ranAt: Date;
  measurements: readonly BenchMeasurement[];
}

/**
 * Write one row per measured upstream. Returns how many landed.
 *
 * A measurement with no numbers at all is still written when it carries a
 * `note`: "this host refused every call" is a finding about the host, and
 * dropping it would leave the series silently shorter than the run.
 */
export const recordBenchRuns = async (
  input: RecordBenchRunsInput,
): Promise<number> => {
  if (input.measurements.length === 0) return 0;

  const rows = input.measurements.map(({ provider, ...metrics }) => ({
    profileKey: input.profileKey,
    provider,
    transport: input.transport,
    metrics,
    ranAt: input.ranAt,
  }));

  await db.insert(modelBenchRuns).values(rows);
  return rows.length;
};

/**
 * The most recent measurements for a model, newest first.
 *
 * `since` exists because a bench row does not age gracefully: upstreams
 * reprice, requantise and change hardware, so a six-month-old throughput is
 * not weak evidence, it is misleading evidence presented with the same
 * authority as a fresh one.
 */
export const readRecentBenchRuns = async (
  profileKey: string,
  options?: { since?: Date; limit?: number },
): Promise<
  {
    provider: string;
    transport: TransportId;
    metrics: Omit<BenchMeasurement, "provider">;
    ranAt: Date;
  }[]
> => {
  const since = options?.since;
  const rows = await db
    .select({
      provider: modelBenchRuns.provider,
      transport: modelBenchRuns.transport,
      metrics: modelBenchRuns.metrics,
      ranAt: modelBenchRuns.ranAt,
    })
    .from(modelBenchRuns)
    .where(
      since === undefined
        ? eq(modelBenchRuns.profileKey, profileKey)
        : and(
            eq(modelBenchRuns.profileKey, profileKey),
            gte(modelBenchRuns.ranAt, since),
          ),
    )
    .orderBy(desc(modelBenchRuns.ranAt))
    .limit(options?.limit ?? 50);

  return rows;
};
