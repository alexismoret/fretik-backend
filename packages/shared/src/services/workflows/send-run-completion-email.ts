import db from "../../db";
import {
  generateWorkflowRunFailed,
  generateWorkflowRunFinished,
} from "../../emails/generators";
import { sendEmail } from "../../lib/email";
import {
  buildSessionFileAttachments,
  type EmailAttachmentFile,
} from "../../lib/email-attachments";
import { resolveRunNotificationRecipients } from "./notification-recipients";

/**
 * Email the configured recipients that a run finished (succeeded or
 * failed). Canceled and test runs never email; the workflow's
 * `notifications.emailOnCompletion` switch gates everything.
 *
 * Designed to be called fire-and-forget right after a `finalizeRun` that
 * reported `transitioned: true` (the exactly-once signal) — every failure
 * path logs and returns rather than throwing, so a flaky email run never
 * breaks the turn loop, the orchestrator callback, or a sweeper.
 */
export const sendRunCompletionEmailIfEnabled = async (params: {
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
      outputSummary: true,
      outputs: true,
      error: true,
    },
  });
  if (!run) {
    console.warn(`${logPrefix} completion email: run not found, skipping`);
    return;
  }
  // Canceled runs were stopped on purpose; test runs already notify their
  // source conversation.
  if (run.status !== "succeeded" && run.status !== "failed") return;
  if (run.isTest) return;

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

  const base = {
    workflowId: run.workflowId,
    runId: run.id,
    workflowName: workflow.name,
  };

  if (run.status === "failed") {
    for (const recipient of recipients) {
      const { subject, html } = await generateWorkflowRunFailed(
        {
          ...base,
          userName: recipient.name,
          errorCode: run.error?.code ?? null,
          errorMessage: run.error?.message ?? null,
          outputSummaryMarkdown: run.outputSummary,
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
      `${logPrefix} failed email sent to ${recipients.length.toString()} recipient(s)`,
    );
    return;
  }

  // Succeeded — attach the run's produced files (outputs with a filePath),
  // built once and shared across recipients. `label` is the filename
  // (`collectRunOutputs` sets it from the presented file).
  const files: EmailAttachmentFile[] = (run.outputs ?? [])
    .filter((o): o is typeof o & { filePath: string } => Boolean(o.filePath))
    .map((o) => ({
      path: o.filePath,
      filename: o.label,
      mimeType: o.mimeType ?? "application/octet-stream",
      ...(o.sizeBytes !== undefined ? { size: o.sizeBytes } : {}),
    }));
  const { attachments, oversized } = run.conversationId
    ? await buildSessionFileAttachments({
        conversationId: run.conversationId,
        files,
        logPrefix,
      })
    : { attachments: [], oversized: false };

  for (const recipient of recipients) {
    const { subject, html } = await generateWorkflowRunFinished(
      {
        ...base,
        userName: recipient.name,
        outputSummaryMarkdown: run.outputSummary ?? "",
        oversizedAttachments: oversized,
      },
      recipient.language,
    );
    await sendEmail({
      to: { email: recipient.email, name: recipient.name },
      subject,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  console.info(
    `${logPrefix} finished email sent to ${recipients.length.toString()} recipient(s)`,
  );
};
