import type { ConversationBackgroundTask } from "../../db/schema";
import type {
  ConversationBackgroundTaskResponse,
  SubAgentStateResponse,
} from "../../schemas/ai";

/** DB row → API shape: the kind-specific metadata is flattened out. */
export const serializeConversationTask = (
  task: ConversationBackgroundTask,
): ConversationBackgroundTaskResponse => ({
  id: task.id,
  kind: task.kind,
  ref: task.ref,
  title: task.title,
  status: task.status,
  workflowId: task.metadata?.workflowId ?? null,
  isTest: task.metadata?.isTest ?? false,
  importCollectionKey: task.metadata?.importCollectionKey ?? null,
  importRows: task.metadata?.importRows ?? null,
  // Kind-agnostic: whatever the work counts. Absent when it counts nothing.
  progress:
    task.metadata?.progressTotal !== undefined
      ? {
          done: task.metadata.progressDone ?? 0,
          total: task.metadata.progressTotal,
        }
      : null,
  createdAt: task.createdAt,
  completedAt: task.completedAt,
});

/**
 * A `sub_agent` row → the state its chat card draws. The report travels only
 * here, never in the task list the chat polls every few seconds: a dozen
 * reports of several pages each have no business in that loop.
 */
export const serializeSubAgentTask = (
  task: ConversationBackgroundTask,
): SubAgentStateResponse => {
  const state = task.metadata?.subAgent;
  const result = state?.result;
  return {
    agentId: task.ref,
    status: task.status,
    model: state?.model ?? null,
    step: state?.step ?? null,
    startedAt: state?.startedAt ?? null,
    activity: state?.activity ?? [],
    result: result
      ? {
          status: result.status,
          summary: result.summary,
          files: result.files ?? [],
          reason: result.reason ?? null,
          toolCalls: result.toolCalls,
          durationMs: result.durationMs,
          activity: result.activity,
        }
      : null,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
};
