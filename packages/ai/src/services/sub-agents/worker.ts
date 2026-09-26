import { publishConversationTaskResume } from "@fretik/shared/lib/conversation-task-resume";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { SUB_AGENT_QUEUE } from "@fretik/shared/lib/queue/sub-agents";
import { completeConversationTask } from "@fretik/shared/services/conversation-tasks/complete";
import { Worker } from "bullmq";
import { getSubAgentSet } from "../../agents/chatbot/delegate";
import { parseIntEnv } from "../../agents/shared/env";
import { resolveChatModelForProfile } from "../../lib/model-registry/resolve";
import type { SubAgentJobData } from "./queue";
import { runSubAgentJob } from "./run-job";

/**
 * The consumer side of the sub-agent queue, one per AI replica.
 *
 * Every replica runs one: a sub-agent needs nothing of the replica that
 * launched it (`queue.ts`), so the work spreads over the fleet, and a replica
 * that dies mid-run hands its jobs to the others. That hand-over is BullMQ's
 * stalled-job recovery: a worker renews its lock on a running job; a process
 * that stops renewing it (killed by a deploy, crashed) loses the lock, and the
 * next stall check moves the job back to the queue for any worker to restart —
 * once (`maxStalledCount`), because a job that kills its process twice is the
 * job, not the process. The restarted run starts from its brief again: a
 * sub-agent changes no team data, so a rerun repeats reads, never writes.
 */

/** Sub-agents one replica runs at once — each mostly waits on a model. */
const concurrency = (): number =>
  parseIntEnv("SUB_AGENT_WORKER_CONCURRENCY", {
    fallback: 8,
    min: 1,
    max: 64,
  });

/**
 * How long a worker holds a job without renewing its lock. Above the default
 * 30 s so a busy event loop (a large tool result being parsed) is not read as
 * a dead process — which would start the same run a second time beside the
 * first.
 */
const LOCK_DURATION_MS = 60_000;

let worker: Worker<SubAgentJobData> | null = null;

/** Idempotent — called once at boot (`src/index.ts`). */
export const registerSubAgentWorker = (): void => {
  if (worker) return;
  worker = new Worker<SubAgentJobData>(
    SUB_AGENT_QUEUE,
    async (job) => {
      await runSubAgentJob(job.data, {
        resolve: (profileKey) => {
          const set = getSubAgentSet(profileKey);
          return {
            primary: set.primary,
            fallback: set.fallback,
            contextCeiling: set.contextCeiling,
            profile: resolveChatModelForProfile(profileKey).profile,
          };
        },
      });
    },
    {
      connection: createWorkerConnection(),
      concurrency: concurrency(),
      lockDuration: LOCK_DURATION_MS,
      maxStalledCount: 1,
    },
  );

  // A run settles its own task whatever happens inside it; a job reaches
  // `failed` only when the queue gave up on it — it stalled once too often.
  // Settle the wait now rather than at the next sweep.
  worker.on("failed", (job, err) => {
    if (job === undefined) return;
    const { agentId, conversationId } = job.data;
    console.error(`[sub-agent] job ${agentId} failed in the queue:`, err);
    void completeConversationTask({
      kind: "sub_agent",
      ref: agentId,
      status: "failed",
      metadata: {
        subAgent: {
          result: {
            status: "failed",
            summary:
              "The sub-agent's process stopped twice mid-run, so it was not restarted. It wrote no report.",
            reason: "interrupted",
            toolCalls: 0,
            durationMs: 0,
            activity: [],
          },
        },
      },
    })
      .then(async ({ transitioned }) => {
        if (transitioned) await publishConversationTaskResume(conversationId);
      })
      .catch((settleErr: unknown) => {
        console.error(
          `[sub-agent] ${agentId} could not be settled after a queue failure:`,
          settleErr,
        );
      });
  });

  worker.on("error", (err) => {
    console.error("[sub-agent] worker error:", err);
  });
};
