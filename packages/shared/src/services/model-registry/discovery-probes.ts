import { and, desc, lt, sql } from "drizzle-orm";
import db from "../../db";
import type { ModelDiscoveryProbeRow } from "../../db/schema/model-registry";
import { modelDiscoveryProbes } from "../../db/schema/model-registry";
import type { TransportId } from "../../model-registry/types";

/**
 * Discovery's memory: what it has already looked at, and what it decided.
 *
 * See the table's own note for why this exists. The short version: a nightly
 * budget without a cursor re-spends itself on the same models for ever.
 */

/**
 * How long a verdict stands before the model is worth looking at again.
 *
 * Three weeks is a market interval, not an arbitrary one: what changes a
 * rejection is a price cut, a new host, or a zero-retention route appearing —
 * all things that happen on the scale of weeks. Shorter and the frontier stops
 * advancing again (the whole backlog would come back before it is swept once);
 * longer and a model that became eligible waits a month to be noticed.
 */
export const DISCOVERY_RECHECK_DAYS = 21;

/**
 * When a verdict stops being worth keeping at all. Beyond this the row is
 * deleted rather than kept as history: this table is a cursor, and a reason
 * from two months ago describes a market that no longer exists.
 */
export const DISCOVERY_PROBE_TTL_DAYS = 60;

const DAY_MS = 24 * 60 * 60_000;

/**
 * OpenRouter ids that are ROUTING VARIANTS rather than models.
 *
 * They are 95 of the 797 catalogue entries (2026-09-02) and they sort to the
 * head of the frontier, which is the worst place for them:
 *
 * - `:batch` (65) — the asynchronous batch API. Nothing a chat turn can use.
 * - `:free` (18) — the same weights on a rate-limited, single-host route. The
 *   registry already declined free routes on measurement (`glm-5.2:free`,
 *   2026-09-01: one fp4 host, 92 % uptime), and a free variant discovered
 *   alongside its paid twin competes with it under a second key.
 * - `~…-latest` (12) — moving aliases. What they point at changes without
 *   notice, which is the one thing a registry of measured routes cannot allow:
 *   every figure on the row would describe a model that has since been swapped.
 */
export const isDiscoveryVariant = (catalogueId: string): boolean =>
  catalogueId.startsWith("~") ||
  catalogueId.endsWith(":free") ||
  catalogueId.endsWith(":batch");

/**
 * Ids whose verdict still stands, so this pass can skip them.
 *
 * Returns a Set rather than the rows: the caller is filtering a few hundred
 * entries and wants membership, and reading only what is still fresh keeps the
 * answer small even when the purge has not run.
 */
export const readStandingDiscoveryVerdicts = async (
  now: Date,
): Promise<Set<string>> => {
  const cutoff = new Date(now.getTime() - DISCOVERY_RECHECK_DAYS * DAY_MS);
  const rows = await db
    .select({ catalogueId: modelDiscoveryProbes.catalogueId })
    .from(modelDiscoveryProbes)
    .where(sql`${modelDiscoveryProbes.examinedAt} >= ${cutoff}`);
  return new Set(rows.map((row) => row.catalogueId));
};

export const recordDiscoveryProbe = async (input: {
  catalogueId: string;
  transport: TransportId;
  verdict: "accepted" | "rejected" | "unreachable";
  reason: string;
  endpointCount: number;
  now: Date;
}): Promise<void> => {
  const values = {
    catalogueId: input.catalogueId,
    transport: input.transport,
    verdict: input.verdict,
    reason: input.reason,
    endpointCount: input.endpointCount,
    examinedAt: input.now,
  };
  await db
    .insert(modelDiscoveryProbes)
    .values(values)
    // One row per id: this is a cursor. A second verdict REPLACES the first,
    // because what matters is what discovery thinks now, not what it thought.
    .onConflictDoUpdate({
      target: modelDiscoveryProbes.catalogueId,
      set: {
        transport: values.transport,
        verdict: values.verdict,
        reason: values.reason,
        endpointCount: values.endpointCount,
        examinedAt: values.examinedAt,
      },
    });
};

/** Drop verdicts too old to mean anything. Returns how many were removed. */
export const purgeDiscoveryProbes = async (now: Date): Promise<number> => {
  const cutoff = new Date(now.getTime() - DISCOVERY_PROBE_TTL_DAYS * DAY_MS);
  const removed = await db
    .delete(modelDiscoveryProbes)
    .where(lt(modelDiscoveryProbes.examinedAt, cutoff))
    .returning({ id: modelDiscoveryProbes.id });
  return removed.length;
};

/**
 * What discovery last decided, newest first — the answer to "why is this model
 * not in the registry?", which had no answer at all before this table.
 */
export const readRecentDiscoveryProbes = async (input?: {
  limit?: number;
  rejectedOnly?: boolean;
}): Promise<ModelDiscoveryProbeRow[]> =>
  db
    .select()
    .from(modelDiscoveryProbes)
    .where(
      input?.rejectedOnly === true
        ? and(sql`${modelDiscoveryProbes.verdict} <> 'accepted'`)
        : undefined,
    )
    .orderBy(desc(modelDiscoveryProbes.examinedAt))
    .limit(input?.limit ?? 50);

/** How many verdicts stand, and how many models discovery has never reached. */
export const countDiscoveryProbes = async (): Promise<number> => {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(modelDiscoveryProbes);
  return row?.total ?? 0;
};
