import db from "../../db";
import {
  generateWorkflowRunFailed,
  generateWorkflowRunFinished,
} from "../../emails/generators";
import { sendEmail } from "../../lib/email";
import {
  buildSessionFileAttachments,
  type BuiltEmailAttachment,
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
  //
  // Every exit below says which one it took. They were all silent until
  // 2026-09-17, when a user reported never receiving a completion email and
  // the run's whole log window held nothing at all: not a send, not a warning,
  // no line to tell a correct decision from a broken one. Three of the four
  // are the intended behaviour, and that is exactly why they have to be
  // legible — an intended silence and a bug look identical from outside.
  if (run.status !== "succeeded" && run.status !== "failed") {
    console.info(
      `${logPrefix} completion email: skipped, run is ${run.status}`,
    );
    return;
  }
  if (run.isTest) {
    console.info(`${logPrefix} completion email: skipped, test run`);
    return;
  }

  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { name: true, notifications: true },
  });
  if (!workflow) {
    console.warn(`${logPrefix} completion email: workflow not found, skipping`);
    return;
  }
  if (!workflow.notifications.emailOnCompletion) {
    console.info(
      `${logPrefix} completion email: skipped, emailOnCompletion is off`,
    );
    return;
  }

  const recipients = await resolveRunNotificationRecipients({
    teamId: run.teamId,
    notifications: workflow.notifications,
    triggeredByUserId: run.triggeredByUserId,
  });
  if (recipients.length === 0) {
    // The configuration resolved to nobody. Legitimate when a public form was
    // submitted anonymously and no explicit list was set; a misconfiguration
    // when neither holds — so name both halves and let the reader tell which.
    console.warn(
      `${logPrefix} completion email: enabled but 0 recipients — notifyTriggeredBy=${workflow.notifications.notifyTriggeredBy.toString()} triggeredByUserId=${run.triggeredByUserId ?? "none"} explicitRecipients=${workflow.notifications.recipientUserIds.length.toString()}`,
    );
    return;
  }

  const base = {
    workflowId: run.workflowId,
    runId: run.id,
    workflowName: workflow.name,
  };

  /**
   * One recipient's failure is theirs alone.
   *
   * The loop used to `await sendEmail` bare: a bounced address, a rate limit
   * or a template error on the first recipient threw out of the loop, and the
   * caller's `.catch` swallowed it — so everyone after them silently got
   * nothing, in the order they happened to be stored.
   */
  const sendEach = async (
    build: (recipient: (typeof recipients)[number]) => Promise<{
      subject: string;
      html: string;
    }>,
    attachments: BuiltEmailAttachment[],
    kind: string,
  ): Promise<void> => {
    let sent = 0;
    for (const recipient of recipients) {
      try {
        const { subject, html } = await build(recipient);
        await sendEmail({
          to: { email: recipient.email, name: recipient.name },
          subject,
          html,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        sent += 1;
      } catch (err) {
        console.error(
          `${logPrefix} ${kind} email to ${recipient.email} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.info(
      `${logPrefix} ${kind} email sent to ${sent.toString()}/${recipients.length.toString()} recipient(s)`,
    );
  };

  if (run.status === "failed") {
    await sendEach(
      (recipient) =>
        generateWorkflowRunFailed(
          {
            ...base,
            userName: recipient.name,
            errorCode: run.error?.code ?? null,
            errorMessage: run.error?.message ?? null,
            outputSummaryMarkdown: run.outputSummary,
          },
          recipient.language,
        ),
      [],
      "failed",
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

  await sendEach(
    (recipient) =>
      generateWorkflowRunFinished(
        {
          ...base,
          userName: recipient.name,
          outputSummaryMarkdown: run.outputSummary ?? "",
          oversizedAttachments: oversized,
        },
        recipient.language,
      ),
    attachments,
    "finished",
  );
};
