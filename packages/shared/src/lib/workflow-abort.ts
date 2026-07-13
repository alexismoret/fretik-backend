import { redis } from "./redis";

/**
 * Redis pub/sub channel carrying an explicit Stop signal to the in-flight
 * workflow turn that owns `runId`. Mirrors the chatbot abort channel: the
 * AI-service turn handler subscribes to it and aborts the server-owned
 * controller passed to the model, so a Stop truncates a turn mid-generation.
 * The Trigger orchestrator is separately cancelled via `runs.cancel` (which
 * kills the whole run loop, including a parked approval wait).
 */
export const workflowAbortChannel = (runId: string): string =>
  `fretik-workflow-abort:${runId}`;

/** Publish a Stop to any turn currently running for this run. */
export const publishWorkflowAbort = async (runId: string): Promise<void> => {
  await redis.publish(workflowAbortChannel(runId), "stop");
};
