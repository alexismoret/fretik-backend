import db from "@fretik/shared/db";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { triggerContextVectorRefreshOrThrow } from "@fretik/shared/services/ai-context/vector-refresh";
import { triggerMemoryVectorRefreshOrThrow } from "@fretik/shared/services/ai-memory/vector-refresh";
import {
  listMissingVectorSources,
  listStaleVectorSources,
  purgeOrphanVectors,
} from "@fretik/shared/services/ai-vectors/reconcile";
import { RECONCILABLE_SOURCE_TYPES } from "@fretik/shared/services/ai-vectors/reconcile-predicates";
import { scheduleDocumentVectorRefresh } from "@fretik/shared/services/documents/vector-refresh-queue";
import { refreshEpisodeVectorsOrThrow } from "@fretik/shared/services/episodes/vector-refresh";
import { refreshPageVectorsOrThrow } from "@fretik/shared/services/pages/vector-refresh";
import { refreshWorkflowVectorsOrThrow } from "@fretik/shared/services/workflows/vector-refresh";
import { type Job, Worker } from "bullmq";
import { intFromEnv } from "../lib/env";
import {
  VECTOR_RECONCILE_QUEUE,
  VECTOR_RECONCILE_SWEEP_JOB,
  VECTOR_REPAIR_JOB,
  type VectorRepairJobData,
} from "../queues/names";
import { getVectorReconcileQueue } from "../queues/queues";

/**
 * Nightly reconciliation of `ai_vectors` against the rows it indexes.
 *
 * The write paths that maintain vectors are fire-and-forget by design — a
 * failed index must not roll back the save it accompanies. That trade is only
 * sound with something that notices what got dropped, and this is it: the
 * sweep finds vectors whose parent is gone, parents with no vectors, and
 * vectors older than the row they describe, then repairs each one as its own
 * retryable job.
 *
 * Detection is in `@fretik/shared`; the ordering, the caps and the AI-service
 * calls are here.
 */

/**
 * Repairs in flight. Each is one embedding round trip, bounded downstream by
 * the shared `openrouter:embeddings` semaphore — this only decides how much of
 * it a nightly pass may claim while nobody is watching.
 */
const CONCURRENCY = intFromEnv("VECTOR_RECONCILE_CONCURRENCY", 3);

/**
 * How many repairs one pass may enqueue per type.
 *
 * Not a throttle — the queue's own concurrency is the throttle, and BullMQ
 * drains a long list happily. This only bounds how much a single pass holds in
 * memory and hands to Redis at once. Whatever it leaves behind is found again
 * tomorrow, and the per-source `jobId` means a re-sweep never duplicates work
 * still queued. When it truncates, it says so: a cap that stays silent reads
 * as "everything was covered" when it was not.
 */
const MAX_PER_TYPE = intFromEnv("VECTOR_RECONCILE_MAX_PER_TYPE", 2_000);

interface SweepCounts {
  orphans: number;
  missing: number;
  stale: number;
}

const repair = async (data: VectorRepairJobData): Promise<void> => {
  switch (data.sourceType) {
    case "pages":
      await refreshPageVectorsOrThrow(data.sourceId);
      return;
    case "workflows":
      await refreshWorkflowVectorsOrThrow(data.sourceId);
      return;
    case "episodes":
      await refreshEpisodeVectorsOrThrow(data.sourceId);
      return;
    case "context":
      await triggerContextVectorRefreshOrThrow(data.sourceId);
      return;
    case "memories":
    case "documents":
      // Both need their tenant ids, which the payload deliberately does not
      // carry (a stale payload is worse than a re-read). Handled by
      // `repairWithScope` below.
      throw new Error(`${data.sourceType} repairs go through repairWithScope`);
    default:
      throw new Error(`No repair path for source type ${data.sourceType}`);
  }
};

/**
 * The sweep: purge orphans, then enqueue one repair per missing or stale
 * source.
 *
 * It acts every night, with no flag to arm. The predicates are covered by unit
 * tests rather than by a human reading counts at 01:00 — an operator who has
 * to approve a maintenance job is an operator who eventually stops reading it.
 */
export const runVectorReconcileSweep = async (): Promise<
  Record<string, SweepCounts>
> => {
  const report: Record<string, SweepCounts> = {};
  const repairs: VectorRepairJobData[] = [];

  for (const sourceType of RECONCILABLE_SOURCE_TYPES) {
    try {
      const orphans = await purgeOrphanVectors(sourceType);
      const missing = await listMissingVectorSources({
        sourceType,
        limit: MAX_PER_TYPE,
      });
      const stale = await listStaleVectorSources({
        sourceType,
        limit: MAX_PER_TYPE,
      });

      report[sourceType] = {
        orphans,
        missing: missing.length,
        stale: stale.length,
      };
      // Hitting the ceiling means the backlog outlives this pass — say so,
      // rather than letting a truncated run read as a complete one.
      if (missing.length === MAX_PER_TYPE || stale.length === MAX_PER_TYPE) {
        console.warn(
          `[vector-reconcile] ${sourceType} hit the ${MAX_PER_TYPE.toString()}/pass ceiling — the remainder is picked up tomorrow.`,
        );
      }
      for (const sourceId of new Set([...missing, ...stale])) {
        repairs.push({ sourceType, sourceId });
      }
    } catch (cause) {
      // One bad type must not stop the pass — the others still get swept.
      console.warn(
        `[vector-reconcile] skipped ${sourceType}:`,
        cause instanceof Error ? cause.message : cause,
      );
    }
  }

  if (repairs.length > 0) {
    const queue = getVectorReconcileQueue();
    // Remove-then-add: BullMQ refuses an `add` whose jobId already exists in
    // ANY state, completed included, and terminal jobs are retained here.
    await Promise.all(
      repairs.map((r) =>
        queue.remove(`vec-${r.sourceType}-${r.sourceId}`).catch(() => {}),
      ),
    );
    await queue.addBulk(
      repairs.map((r) => ({
        name: VECTOR_REPAIR_JOB,
        data: r,
        opts: {
          jobId: `vec-${r.sourceType}-${r.sourceId}`,
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 10_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 1_000 },
        },
      })),
    );
  }

  const total = Object.values(report).reduce(
    (acc, c) => acc + c.orphans + c.missing + c.stale,
    0,
  );
  // Silent on a clean pass, so a log line IS the signal — same discipline as
  // the collection-index sweep.
  if (total > 0) {
    console.info(`[vector-reconcile] ${JSON.stringify(report)}`);
  }
  return report;
};

export const startVectorReconcileWorker = (): Worker => {
  const worker = new Worker(
    VECTOR_RECONCILE_QUEUE,
    async (job: Job) => {
      if (job.name === VECTOR_RECONCILE_SWEEP_JOB) {
        await runVectorReconcileSweep();
        return;
      }
      await repairWithScope(job.data as VectorRepairJobData);
    },
    { connection: createWorkerConnection(), concurrency: CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[vector-reconcile] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};

/**
 * Dispatch a repair, re-reading whatever scope the refresher needs.
 *
 * Memories and documents take their tenant ids as arguments, and the payload
 * carries only the source id — so they are looked up fresh here rather than
 * trusted from a job that may have sat in Redis for hours.
 */
const repairWithScope = async (data: VectorRepairJobData): Promise<void> => {
  if (data.sourceType === "memories") {
    const memory = await db.query.aiMemories.findFirst({
      where: { id: data.sourceId },
      columns: { teamId: true, organizationId: true },
    });
    if (!memory) return;
    await triggerMemoryVectorRefreshOrThrow(
      data.sourceId,
      memory.teamId,
      memory.organizationId,
    );
    return;
  }
  if (data.sourceType === "documents") {
    const doc = await db.query.documents.findFirst({
      where: { id: data.sourceId },
      columns: { teamId: true },
    });
    if (!doc) return;
    // `documents` carries only the team; the org comes from it.
    const team = await db.query.team.findFirst({
      where: { id: doc.teamId },
      columns: { organizationId: true },
    });
    if (!team) return;
    // Documents keep their own debounce queue — reuse it rather than opening a
    // second path to the same work.
    await scheduleDocumentVectorRefresh({
      documentId: data.sourceId,
      teamId: doc.teamId,
      organizationId: team.organizationId,
    });
    return;
  }
  await repair(data);
};
