import type { SubAgentStopper } from "../db/schema";
import { redis } from "./redis";

/**
 * Redis pub/sub channel carrying "stop" to the one process running a given
 * sub-agent. A sub-agent runs on whichever AI replica's worker picked its job,
 * while the request to stop it comes from anywhere — the API (the user's Stop
 * button on its row), another replica (the assistant, on a later turn), the
 * turn's own Stop. Same shape as the workflow abort channel.
 *
 * The message is WHO asked, because that decides whether the outcome wakes
 * the conversation (`SubAgentStopper`). Best-effort like every pub/sub signal:
 * a run that has not subscribed yet reads the request off its task row
 * instead (`requestSubAgentStop` writes both).
 */
export const subAgentAbortChannel = (agentId: string): string =>
  `fretik-sub-agent-abort:${agentId}`;

export const publishSubAgentAbort = async (
  agentId: string,
  by: SubAgentStopper,
): Promise<void> => {
  await redis.publish(subAgentAbortChannel(agentId), by);
};
