import { Queue } from "bullmq";
import { getProducerConnection } from "./connection";

/**
 * The queue sub-agents run on. The AI service produces and consumes it
 * (`packages/ai/src/services/sub-agents/`); its name lives here because the
 * maintenance sweep reads it too — to tell a sub-agent waiting for a worker
 * from one whose worker died (`services/conversation-tasks/kinds.ts`).
 */
export const SUB_AGENT_QUEUE = "sub-agents";

let queue: Queue | null = null;

const getQueue = (): Queue => {
  queue ??= new Queue(SUB_AGENT_QUEUE, { connection: getProducerConnection() });
  return queue;
};

/** Job states that still end in a run: waiting for a worker, or on one. */
const OWED_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "prioritized",
  "delayed",
  "active",
  "waiting-children",
]);

/**
 * Which of these sub-agents the queue still owes a run — a job waiting for a
 * worker, or held by one. A job a crashed worker held is `active` until the
 * queue notices its lock lapsed and hands it to another replica, so it counts
 * as owed throughout. One round trip per id, in parallel; a Redis failure
 * answers "all owed", for the reason `liveSubAgents` gives.
 */
export const owedSubAgentJobs = async (
  agentIds: readonly string[],
): Promise<Set<string>> => {
  if (agentIds.length === 0) return new Set();
  try {
    const q = getQueue();
    const states = await Promise.all(agentIds.map((id) => q.getJobState(id)));
    return new Set(
      agentIds.filter((_, index) => OWED_STATES.has(states[index] ?? "")),
    );
  } catch {
    return new Set(agentIds);
  }
};
