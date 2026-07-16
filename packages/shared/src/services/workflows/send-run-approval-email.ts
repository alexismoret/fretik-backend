import db from "../../db";
import type { ToolApprovalPayload } from "../../db/schema/approvals";
import {
  generateWorkflowRunApproval,
  type AskUserQuestionForEmail,
} from "../../emails/generators";
import { renderApprovalSummary } from "../../external-apps/i18n/render-summary";
import { sendEmail } from "../../lib/email";
import { resolveRunNotificationRecipients } from "./notification-recipients";

/**
 * The approval id the parking turn recorded in `lastTurnResult` — untyped
 * jsonb, read defensively (mirrors `serialize.ts` `pendingApprovalId`).
 */
const approvalIdFromTurnResult = (
  lastTurnResult: Record<string, unknown> | null,
): string | null => {
  const value = lastTurnResult?.approvalRequestId;
  return typeof value === "string" ? value : null;
};

/** Questions of a `question` approval — the payload shape mirrors the
 * askUserQuestion tool, so it maps 1:1 onto the email shape. */
const questionsFromPayload = (
  payload: ToolApprovalPayload | null,
): AskUserQuestionForEmail[] | null => {
  if (!payload || !("questions" in payload)) return null;
  return payload.questions.length > 0 ? payload.questions : null;
};

/**
 * Email the configured recipients that a run parked in `needs_approval` —
 * the moment a notification matters most: the run is blocked on a human.
 * Test runs never email; the workflow's `notifications.emailOnCompletion`
 * switch gates everything.
 *
 * Designed to be called fire-and-forget right after a `setRunWaitToken`
 * that reported `parked: true` (a retried wait-token POST must not
 * double-send). Every failure path logs and returns rather than throwing.
 */
export const sendRunApprovalEmailIfEnabled = async (params: {
  runId: string;
}): Promise<void> => {
  const logPrefix = `[workflow-run ${params.runId}]`;

  const run = await db.query.workflowRuns.findFirst({
    where: { id: params.runId },
    columns: {
      id: true,
      workflowId: true,
      teamId: true,
      status: true,
      isTest: true,
      conversationId: true,
      triggeredByUserId: true,
      lastTurnResult: true,
    },
  });
  if (!run) {
    console.warn(`${logPrefix} approval email: run not found, skipping`);
    return;
  }
  if (run.status !== "needs_approval" || run.isTest) return;

  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { name: true, notifications: true },
  });
  if (!workflow || !workflow.notifications.emailOnCompletion) return;

  const recipients = await resolveRunNotificationRecipients({
    teamId: run.teamId,
    notifications: workflow.notifications,
    triggeredByUserId: run.triggeredByUserId,
  });
  if (recipients.length === 0) return;

  // Resolve the pending approval: the id the parking turn recorded, with a
  // fallback to the newest pending row of the run's conversation. Skip when
  // it is no longer `pending` — someone may have decided it between the park
  // and this fire-and-forget callback (same guard as the chatbot email).
  const recordedId = approvalIdFromTurnResult(run.lastTurnResult);
  const approval = recordedId
    ? await db.query.toolApprovalRequests.findFirst({
        where: { id: recordedId },
        columns: {
          conversationId: true,
          status: true,
          summary: true,
          payload: true,
        },
      })
    : run.conversationId
      ? await db.query.toolApprovalRequests.findFirst({
          where: { conversationId: run.conversationId, status: "pending" },
          orderBy: { createdAt: "desc" },
          columns: {
            conversationId: true,
            status: true,
            summary: true,
            payload: true,
          },
        })
      : undefined;
  if (
    !approval ||
    approval.conversationId !== run.conversationId ||
    approval.status !== "pending"
  ) {
    return;
  }

  const questions = questionsFromPayload(approval.payload);
  const base = {
    workflowId: run.workflowId,
    runId: run.id,
    workflowName: workflow.name,
  };

  for (const recipient of recipients) {
    const { subject, html } = await generateWorkflowRunApproval(
      {
        ...base,
        userName: recipient.name,
        // Localized per recipient — the summary carries i18n keys, the
        // questions are already plain text from the tool call.
        ...(approval.summary !== null
          ? {
              summary: renderApprovalSummary(
                approval.summary,
                recipient.language,
              ),
            }
          : {}),
        ...(questions !== null ? { questions } : {}),
      },
      recipient.language,
    );
    await sendEmail({
      to: { email: recipient.email, name: recipient.name },
      subject,
      html,
    });
  }
  console.info(
    `${logPrefix} approval email sent to ${recipients.length.toString()} recipient(s)`,
  );
};
