import { getProducerConnection } from "@fretik/shared/lib/queue/connection";
import { SUB_AGENT_QUEUE } from "@fretik/shared/lib/queue/sub-agents";
import { Queue } from "bullmq";
import type { ChatbotCallOptions } from "../../agents/chatbot/call-options";

/**
 * The queue a sub-agent runs on, once `dispatchAgent` has launched it.
 *
 * Why a queue and not a promise the launching turn leaves running: a sub-agent
 * outlives the tool call that started it, often the turn too, and a promise
 * dies with its process. A deploy stops the AI container mid-run; on this
 * queue the job's lock lapses and another replica's worker picks it up again
 * (`worker.ts`). The work also spreads over every replica instead of piling
 * onto the one that happened to serve the turn.
 *
 * Why BullMQ and not Trigger.dev, which runs the product's other durable
 * agent work (workflow runs): a Trigger task cannot reach Postgres, Redis or
 * E2B by design (`packages/workflows/src/tasks/workflow-run.ts`), so it could
 * only call back into this same service over HTTP — a second deploy unit, a
 * worker slot held for the whole run, a start latency the user watches, and
 * interactive work queued behind hour-long workflow runs, to buy a retry this
 * queue already gives. Same split as `docs/EXTERNAL-DATA-COLUMNS.md` §3.4.
 *
 * Producer here, consumer in `worker.ts` — which imports the agents, which
 * import `dispatchAgent`, which imports this: keeping the two apart is what
 * keeps that loop open. The queue's name lives in `@fretik/shared`, because
 * the maintenance sweep asks it which jobs are still owed a run.
 */

const JOB_NAME = "run";

/**
 * Everything a worker on ANY replica needs to run the sub-agent — hence
 * nothing live: the brief is rendered and the call options resolved at launch,
 * in the process that has the parent's context.
 */
export interface SubAgentJobData {
  agentId: string;
  conversationId: string;
  organizationId: string;
  teamId: string;
  userId?: string;
  /** The 3-6 words the parent gave it. */
  description: string;
  /** Registry profile it runs on — the parent's, or the team's Fast pick. */
  profileKey: string;
  /** Its opening message (`agents/chatbot/delegate-brief.ts`). */
  brief: string;
  callOptions: ChatbotCallOptions;
  /** For the trace only: which turn launched it. */
  parentTraceId?: string;
}

let queue: Queue<SubAgentJobData> | null = null;

const getQueue = (): Queue<SubAgentJobData> => {
  queue ??= new Queue<SubAgentJobData>(SUB_AGENT_QUEUE, {
    connection: getProducerConnection(),
  });
  return queue;
};

/**
 * Hand a launched sub-agent to the workers. `jobId = agentId` makes a retried
 * launch a no-op rather than a second run. One attempt: a model or tool
 * failure is handled inside the run (fallback model, one resume) and a second
 * attempt would only pay for it twice — the retry that matters, after a dead
 * process, is the queue's stalled-job recovery, which is not an attempt.
 */
export const enqueueSubAgent = async (data: SubAgentJobData): Promise<void> => {
  await getQueue().add(JOB_NAME, data, {
    jobId: data.agentId,
    attempts: 1,
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600, count: 1000 },
  });
};
