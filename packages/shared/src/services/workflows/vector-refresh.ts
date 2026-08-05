import { and, eq } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import type { Workflow } from "../../db/schema";
import { aiVectors } from "../../db/schema";
import { callAiService } from "../../lib/ai-service";
import { describeTriggerForCard } from "../../schemas/workflow-triggers";

const aiVectorizeResponseSchema = z.object({
  success: z.boolean(),
  stats: z
    .object({
      chunksProduced: z.number(),
      chunksEnriched: z.number(),
      rowsInserted: z.number(),
      rowsDropped: z.number(),
    })
    .optional(),
});

/**
 * The searchable card for a workflow: what it is for, what it does step by
 * step, and how it is started.
 *
 * Written for the query it must match. A user asks for an OUTCOME ("send the
 * supplier totals every month") without knowing a workflow exists, so the
 * card leads with the goal and the task titles — the words a request is
 * phrased in — rather than with configuration.
 */
export const buildWorkflowCard = (workflow: Workflow): string =>
  [
    `Workflow: ${workflow.name}`,
    ...(workflow.description ? [workflow.description] : []),
    `Goal: ${workflow.playbook.goal}`,
    `Started by: ${describeTriggerForCard(workflow.triggerType, workflow.triggerConfig)}`,
    "Steps:",
    ...workflow.playbook.tasks.map(
      (task, index) =>
        `${(index + 1).toString()}. ${task.title} — ${task.description}`,
    ),
  ].join("\n");

/**
 * Index (or re-index) a workflow so the assistant can find it from a plain
 * request. Idempotent: the AI service skips the embed round-trip when the
 * card is unchanged, and DELETEs the previous rows otherwise.
 *
 * Fire-and-forget: errors are logged, never thrown — the workflow row is the
 * source of truth and a failed index must not roll back a save. The card is
 * refreshed on the next save, so a miss is self-healing.
 */
export const refreshWorkflowVectors = async (
  workflowId: string,
): Promise<void> => {
  try {
    const workflow = await db.query.workflows.findFirst({
      where: { id: workflowId },
    });
    if (!workflow) return;
    // An archived workflow must stop being discoverable — nothing should
    // propose running it.
    if (workflow.status === "archived") {
      await deleteWorkflowVectorRows(workflowId);
      return;
    }

    const result = await callAiService(
      "/internal/vectorize",
      {
        sourceType: "workflows",
        sourceId: workflow.id,
        content: buildWorkflowCard(workflow),
        metadata: {
          name: workflow.name,
          description: workflow.description ?? "",
          trigger_type: workflow.triggerType,
          status: workflow.status,
          task_count: workflow.playbook.tasks.length,
        },
        teamId: workflow.teamId,
        organizationId: workflow.organizationId,
        // A private workflow is only its owner's to find.
        userId: workflow.userId,
      },
      aiVectorizeResponseSchema,
      {
        teamId: workflow.teamId,
        organizationId: workflow.organizationId,
      },
    );

    if (!result.success) {
      console.warn(
        `[WorkflowVectorRefresh] AI service returned success=false for ${workflowId}`,
      );
    }
  } catch (error) {
    console.error(`[WorkflowVectorRefresh] Failed for ${workflowId}:`, error);
  }
};

/**
 * Drop a workflow's card — on delete, or when it is archived. Direct SQL:
 * there is nothing to embed and the round-trip would only slow the delete.
 * Fire-and-forget, same contract as the refresh.
 */
export const deleteWorkflowVectorRows = async (
  workflowId: string,
): Promise<void> => {
  try {
    await db
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "workflows"),
          eq(aiVectors.sourceId, workflowId),
        ),
      );
  } catch (error) {
    console.error(
      `[WorkflowVectorRefresh] Failed to delete vectors for ${workflowId}:`,
      error,
    );
  }
};
