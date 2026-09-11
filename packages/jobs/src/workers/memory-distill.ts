import { callAiService } from "@fretik/shared/lib/ai-service";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { type Job, Worker } from "bullmq";
import { z } from "zod";
import {
  EAGER_CONSOLIDATE_JOB,
  MEMORY_DISTILL_QUEUE,
  type MemoryDistillJobData,
} from "../queues/names";
import { getMemoryDreamingQueue } from "../queues/queues";

/**
 * Distill one quiet conversation into its episode via the AI service
 * (`POST /internal/memory/distill-conversation` owns the whole pipeline:
 * transcript + candidate records → LLM → upsertEpisode → vectorize).
 *
 * Unlike the resolver's soft-fail (where the LLM is a bonus pass on top of
 * the free dictionary pass), distillation IS the LLM call — failures throw
 * so BullMQ retries with backoff. `distilled:false` is a normal outcome
 * (conversation too short, unparsable completion), not a failure.
 */

const CONCURRENCY = 2;

const distillResponseSchema = z.object({
  distilled: z.boolean(),
  episodeId: z.string().optional(),
});

const distill = async (data: MemoryDistillJobData): Promise<void> => {
  const result = await callAiService(
    "/internal/memory/distill-conversation",
    data,
    distillResponseSchema,
    { teamId: data.teamId, organizationId: data.organizationId },
  );
  console.info(
    result.distilled
      ? `[memory-distill] conversation ${data.conversationId} → episode ${result.episodeId ?? "<unknown>"}`
      : `[memory-distill] conversation ${data.conversationId} skipped (too short or unparsable)`,
  );

  // Eager consolidation (P8.3): a fresh/changed episode may now contradict a
  // sibling from another conversation — judge the overlapping cluster within
  // the debounce instead of waiting for 03:00. On the dreaming queue (never
  // the 15s sweep); dedup per episode; best-effort (the nightly pass backstops).
  if (result.distilled && result.episodeId) {
    const episodeId = result.episodeId;
    await getMemoryDreamingQueue()
      .add(
        EAGER_CONSOLIDATE_JOB,
        {
          episodeId,
          teamId: data.teamId,
          organizationId: data.organizationId,
        },
        {
          jobId: `consolidate-${episodeId}`,
          attempts: 1,
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      )
      .catch((err: unknown) => {
        console.warn(
          `[memory-distill] eager consolidate enqueue skipped for ${episodeId}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }
};

export const startMemoryDistillWorker = (): Worker<MemoryDistillJobData> => {
  const worker = new Worker<MemoryDistillJobData>(
    MEMORY_DISTILL_QUEUE,
    (job: Job<MemoryDistillJobData>) => distill(job.data),
    { connection: createWorkerConnection(), concurrency: CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[memory-distill] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
