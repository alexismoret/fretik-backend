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
  createdAt: task.createdAt,
  completedAt: task.completedAt,
});
