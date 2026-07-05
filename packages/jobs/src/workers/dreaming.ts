import { callAiService } from "@fretik/shared/lib/ai-service";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import {
  listConsolidationClusters,
  listDreamingTeams,
  listOverlappingCluster,
  listPromotionCandidates,
  listRecordActivityCandidates,
  listStaleConversationDistills,
} from "@fretik/shared/services/episodes/dreaming-candidates";
import { type Job, Worker } from "bullmq";
import { z } from "zod";
import {
  DREAMING_TEAM_JOB,
  type DreamingTeamJobData,
  type EagerConsolidateJobData,
  MEMORY_DREAMING_QUEUE,
} from "../queues/names";
import {
  type DreamingJobData,
  getMemoryDistillQueue,
  getMemoryDreamingQueue,
} from "../queues/queues";

/**
 * Nightly "dreaming" consolidation (P6). The 03:00 cron on the maintenance
 * queue calls `runDreamingSweep`, which only FANS OUT: one idempotent job per
 * team active in the last 24h (`dreaming-{teamId}-{date}`). The LLM work
 * happens here, teams in parallel (and across replicas — BullMQ spreads the
 * jobs), retried per team. Queue-based rather than batch-API by decision:
 * OpenRouter exposes no batch endpoint, utility-tier calls cost fractions of
 * a cent, and this is time-insensitive background work — a long night is
 * fine, dropped work is not, so there is NO per-team LLM budget. The only
 * bounds are the runaway backstops below, logged loudly when hit.
 *
 * Per team, in priority order (cheapest signal first):
 *  1. distill safety net — re-enqueue lost/stale conversation distills
 *     (the memory-distill worker owns those calls);
 *  2. record_activity digests — busiest records first;
 *  3. consolidation judge — MERGE/REVISE/NOOP per episode cluster.
 * A failed call logs and moves on; the next night's candidate queries
 * re-derive anything missed.
 */

/** Teams processed in parallel per replica. */
const TEAM_CONCURRENCY = 4;
/**
 * Runaway backstops, NOT business caps — orders of magnitude above any real
 * night (a candidate only recurs while its source keeps changing). Hitting
 * one logs a warning: the remainder is picked up the next night.
 */
const MAX_DISTILLS_PER_TEAM = 2_000;
const MAX_DIGESTS_PER_TEAM = 2_000;
const MAX_CLUSTERS_PER_TEAM = 500;
/** Digest thresholds — mirrored by MIN_DIGEST_EVENTS in the AI service. */
const DIGEST_MIN_EVENTS = 5;
const DIGEST_WINDOW_DAYS = 7;
const CLUSTER_WINDOW_DAYS = 30;
/** ≤ the consolidate endpoint's episodeIds max (8). */
const MAX_CLUSTER_SIZE = 6;
/**
 * Promotion (P8.5): a record needs ≥ this many episodes in the window to be a
 * candidate (recurrence = a durable fact may hide there). Tight per-team cap —
 * promotion writes to team-shared semantic memory, so a slow trickle beats a
 * flood; the rest waits for the next night.
 */
const PROMOTE_MIN_EPISODES = 3;
const PROMOTE_WINDOW_DAYS = 60;
const MAX_PROMOTIONS_PER_TEAM = 5;
/** ≤ the promote endpoint's episodeIds max (12). */
const MAX_PROMOTE_EPISODES = 12;

const distillResponseSchema = z.object({
  distilled: z.boolean(),
  episodeId: z.string().optional(),
});
const consolidateResponseSchema = z.object({
  action: z.enum(["MERGE", "REVISE", "NOOP"]),
  episodeId: z.string().optional(),
  supersededIds: z.array(z.string()).optional(),
});
const promoteResponseSchema = z.object({
  added: z.number(),
  updated: z.number(),
  noop: z.number(),
});

/** Fan out one idempotent per-team job per active team. Called by the cron. */
export const runDreamingSweep = async (): Promise<{ teams: number }> => {
  const teams = await listDreamingTeams();
  if (teams.length === 0) return { teams: 0 };
  const date = new Date().toISOString().slice(0, 10);
  await getMemoryDreamingQueue().addBulk(
    teams.map((t) => ({
      name: DREAMING_TEAM_JOB,
      data: t,
      opts: {
        jobId: `dreaming-${t.teamId}-${date}`,
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    })),
  );
  return { teams: teams.length };
};

const warnIfSaturated = (
  teamId: string,
  what: string,
  n: number,
  max: number,
) => {
  if (n >= max) {
    console.warn(
      `[dreaming] team ${teamId}: ${what} backstop hit (${max.toString()}) — remainder deferred to next night`,
    );
  }
};

export const runDreamingTeam = async (
  data: DreamingTeamJobData,
): Promise<void> => {
  const scope = { teamId: data.teamId, organizationId: data.organizationId };

  // 1. Distill safety net — enqueued, the memory-distill worker owns the calls.
  const stale = await listStaleConversationDistills({
    teamId: data.teamId,
    limit: MAX_DISTILLS_PER_TEAM,
  });
  warnIfSaturated(data.teamId, "distill", stale.length, MAX_DISTILLS_PER_TEAM);
  const distillQueue = getMemoryDistillQueue();
  for (const { conversationId } of stale) {
    const jobId = `distill-${conversationId}`;
    await distillQueue.remove(jobId).catch(() => {});
    await distillQueue
      .add(
        "distill",
        { conversationId, ...scope },
        {
          jobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      )
      .catch((err: unknown) => {
        console.warn(
          `[dreaming] distill enqueue skipped for ${conversationId}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }

  // 2. Record-activity digests, busiest records first.
  let digestsOk = 0;
  let digestsFailed = 0;
  const candidates = await listRecordActivityCandidates({
    teamId: data.teamId,
    minEvents: DIGEST_MIN_EVENTS,
    windowDays: DIGEST_WINDOW_DAYS,
    limit: MAX_DIGESTS_PER_TEAM,
  });
  warnIfSaturated(
    data.teamId,
    "digest",
    candidates.length,
    MAX_DIGESTS_PER_TEAM,
  );
  for (const { recordId } of candidates) {
    try {
      await callAiService(
        "/internal/memory/distill-record-activity",
        { recordId, ...scope },
        distillResponseSchema,
        scope,
      );
      digestsOk++;
    } catch (err) {
      digestsFailed++;
      console.error(
        `[dreaming] digest failed for record ${recordId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 3. Consolidation judge per cluster.
  const actions = { MERGE: 0, REVISE: 0, NOOP: 0 };
  let clustersFailed = 0;
  const clusters = await listConsolidationClusters({
    teamId: data.teamId,
    windowDays: CLUSTER_WINDOW_DAYS,
    maxClusterSize: MAX_CLUSTER_SIZE,
    limit: MAX_CLUSTERS_PER_TEAM,
  });
  warnIfSaturated(
    data.teamId,
    "cluster",
    clusters.length,
    MAX_CLUSTERS_PER_TEAM,
  );
  for (const cluster of clusters) {
    try {
      const result = await callAiService(
        "/internal/memory/consolidate-episodes",
        { episodeIds: cluster.episodeIds, ...scope },
        consolidateResponseSchema,
        scope,
      );
      actions[result.action]++;
    } catch (err) {
      clustersFailed++;
      console.error(
        `[dreaming] consolidation failed for team ${data.teamId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 4. Semantic promotion — durable facts recurring across a record's episodes.
  let promoted = 0;
  let promotionsFailed = 0;
  const promotionCandidates = await listPromotionCandidates({
    teamId: data.teamId,
    minEpisodes: PROMOTE_MIN_EPISODES,
    windowDays: PROMOTE_WINDOW_DAYS,
    limit: MAX_PROMOTIONS_PER_TEAM,
  });
  for (const candidate of promotionCandidates) {
    try {
      const result = await callAiService(
        "/internal/memory/promote-episodes",
        {
          episodeIds: candidate.episodeIds.slice(0, MAX_PROMOTE_EPISODES),
          ...scope,
        },
        promoteResponseSchema,
        scope,
      );
      promoted += result.added + result.updated;
    } catch (err) {
      promotionsFailed++;
      console.error(
        `[dreaming] promotion failed for record ${candidate.recordId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.info(
    `[dreaming] team ${data.teamId}: ${stale.length.toString()} distills enqueued, ` +
      `digests ${digestsOk.toString()} ok / ${digestsFailed.toString()} failed, ` +
      `clusters ${actions.MERGE.toString()} merged / ${actions.REVISE.toString()} revised / ` +
      `${actions.NOOP.toString()} noop / ${clustersFailed.toString()} failed, ` +
      `promotions ${promoted.toString()} written / ${promotionsFailed.toString()} failed`,
  );
};

/**
 * Eager consolidation (P8.3): the cluster overlapping ONE just-distilled
 * episode, judged now instead of at 03:00 — a cross-conversation
 * contradiction is caught within the distill debounce. `listOverlappingCluster`
 * returns null (a single cheap SQL query) when nothing overlaps, so most
 * distills cost no LLM call. Best-effort: a failure logs and defers to the
 * nightly pass, which re-derives the same cluster.
 */
export const runEagerConsolidation = async (
  data: EagerConsolidateJobData,
): Promise<void> => {
  const scope = { teamId: data.teamId, organizationId: data.organizationId };
  const cluster = await listOverlappingCluster({
    episodeId: data.episodeId,
    windowDays: CLUSTER_WINDOW_DAYS,
    maxClusterSize: MAX_CLUSTER_SIZE,
  });
  if (!cluster) return;
  try {
    const result = await callAiService(
      "/internal/memory/consolidate-episodes",
      { episodeIds: cluster.episodeIds, ...scope },
      consolidateResponseSchema,
      scope,
    );
    console.info(
      `[dreaming] eager consolidate episode ${data.episodeId}: ${result.action}`,
    );
  } catch (err) {
    console.error(
      `[dreaming] eager consolidation failed for episode ${data.episodeId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};

export const startDreamingWorker = (): Worker<DreamingJobData> => {
  const worker = new Worker<DreamingJobData>(
    MEMORY_DREAMING_QUEUE,
    (job: Job<DreamingJobData>) =>
      "episodeId" in job.data
        ? runEagerConsolidation(job.data)
        : runDreamingTeam(job.data),
    { connection: createWorkerConnection(), concurrency: TEAM_CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[dreaming] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
