import { redis } from "./redis";

/**
 * Proof of life for a sub-agent running in the background.
 *
 * A background sub-agent runs inside the AI process that launched it, and
 * nothing else records that it is running: its task row says `pending` from
 * launch to completion. A process that dies mid-run (a deploy, a crash) leaves
 * that row pending forever — and with it the conversation's resume, which
 * waits for every pending task. The run therefore beats a short-lived key while
 * it works, and the maintenance sweep reads its absence as death
 * (`conversation-tasks/kinds.ts`).
 *
 * Expires on its own rather than being trusted to be deleted: the process that
 * would delete it is exactly the one that may be gone.
 */

/** Refresh period of a live run. */
export const SUB_AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Four missed beats before a run reads as dead. */
const HEARTBEAT_TTL_S = 120;

const heartbeatKey = (agentId: string): string =>
  `sub-agent:heartbeat:${agentId}`;

/** Record that the run is alive. Best-effort: a missed beat costs nothing. */
export const beatSubAgent = async (agentId: string): Promise<void> => {
  await redis.set(heartbeatKey(agentId), "1", "EX", HEARTBEAT_TTL_S);
};

/** Drop the key once the run is over, so the sweep never has to wait it out. */
export const clearSubAgentHeartbeat = async (
  agentId: string,
): Promise<void> => {
  await redis.del(heartbeatKey(agentId));
};

/**
 * Which of these runs are still beating. One round trip for the batch. A Redis
 * failure answers "all alive": declaring a live run dead would hand the parent
 * a failure for work that is about to succeed, while a false "alive" only
 * delays the next sweep's verdict.
 */
export const liveSubAgents = async (
  agentIds: readonly string[],
): Promise<Set<string>> => {
  if (agentIds.length === 0) return new Set();
  try {
    const values = await redis.mget(...agentIds.map(heartbeatKey));
    return new Set(agentIds.filter((_, index) => values[index] !== null));
  } catch {
    return new Set(agentIds);
  }
};
