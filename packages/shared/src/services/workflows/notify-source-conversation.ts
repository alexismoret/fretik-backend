import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema";
import { publishConversationEvent } from "../ai/conversation-events";
import { saveMessage } from "../ai/messages";

const NOTIFICATION_KIND = "workflow-run-notification";

const STATUS_LABEL: Record<string, string> = {
  succeeded: "finished",
  failed: "failed",
  canceled: "was canceled",
};

/**
 * Post a one-line completion notice for a finished run back into the CHAT
 * conversation that launched it (a builder `run_test`), so the user learns the
 * outcome without leaving chat. No-op when the run has no `sourceConversationId`
 * (cron / event / API runs) or is not yet terminal.
 *
 * Idempotent: it first checks the source conversation for an existing notice
 * carrying this run id, so it is safe to call from every terminal path (the
 * turn-close handler, the orchestrator's finalize route, cancel-run). Best
 * effort — call fire-and-forget; a failed notice must never fail a finalize.
 */
export const notifySourceConversation = async (params: {
  runId: string;
}): Promise<void> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { id: params.runId },
    columns: {
      sourceConversationId: true,
      workflowId: true,
      status: true,
      outputSummary: true,
    },
  });
  if (!run?.sourceConversationId) return;
  if (
    run.status !== "succeeded" &&
    run.status !== "failed" &&
    run.status !== "canceled"
  ) {
    return;
  }
  const conversationId = run.sourceConversationId;

  // Dedup: at most one notice per run, even if several terminal paths race.
  const existing = await db
    .select({ id: aiMessages.id })
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        sql`${aiMessages.metadata}->>'kind' = ${NOTIFICATION_KIND}`,
        sql`${aiMessages.metadata}->>'runId' = ${params.runId}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { name: true },
  });
  const name = workflow?.name ?? "Workflow";
  const label = STATUS_LABEL[run.status] ?? run.status;
  const summary = run.outputSummary?.trim();
  const text = `**${name}** ${label}.${summary ? ` ${summary}` : ""}\n\n[Open the run](/workflows/${run.workflowId})`;

  const row = await saveMessage({
    conversationId,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: {
      kind: NOTIFICATION_KIND,
      runId: params.runId,
      workflowId: run.workflowId,
      status: run.status,
    },
  });
  await publishConversationEvent(conversationId, {
    type: "message-added",
    messageId: row?.id ?? "",
    role: "assistant",
    authorId: null,
  });
};
