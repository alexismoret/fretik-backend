import type { ConversationBackgroundTask } from "../../db/schema";
import type { ConversationBackgroundTaskResponse } from "../../schemas/ai";

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
