import db from "@fretik/shared/db";
import {
  generateChatbotApprovalPending,
  generateChatbotFinished,
  generateChatbotFinishedAwaitingAnswers,
  type AskUserQuestionForEmail,
} from "@fretik/shared/emails/generators";
import { renderApprovalSummary } from "@fretik/shared/external-apps/i18n/render-summary";
import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import { sendEmail } from "@fretik/shared/lib/email";
import { getTeamLocale } from "@fretik/shared/services/field-definitions/get-locale";
import type { UIMessage } from "ai";

/**
 * Hard cap on the total raw byte size of `presentFiles` outputs we
 * are willing to attach to the completion email. Scaleway TEM caps
 * the entire request payload at 25 MB *including* base64 expansion
 * (≈1.37×) and the JSON envelope; Gmail/Outlook bounce anything
 * larger downstream of Scaleway anyway. 20 MB raw → ≈27 MB encoded
 * which leaves us comfortable headroom in both directions.
 */
const MAX_ATTACHMENT_BYTES_TOTAL = 20 * 1024 * 1024;

/**
 * Tighten a filename so it can ride safely in an email header. The
 * `presentFiles` tool already sanitises path segments, but a defence
 * in depth here keeps unrelated upstream changes (e.g. an admin tool
 * uploading something raw) from leaking weird characters into MIME
 * headers and breaking the message.
 */
const sanitizeAttachmentFilename = (filename: string): string => {
  const base = filename.split("/").pop() ?? filename;
  const trimmed = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return trimmed.length > 0 ? trimmed : "attachment";
};

/**
 * Concatenate every `text` part of an assistant `UIMessage` into one
 * markdown blob. Tool-only turns return an empty string so the caller
 * can short-circuit (no body → no email).
 */
const extractAssistantMarkdown = (message: UIMessage): string => {
  const fragments: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      fragments.push(part.text);
    }
  }
  return fragments.join("").trim();
};

interface PresentedFileFromTool {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Pull the `presentFiles` tool outputs off the assistant message we
 * are about to email. AI SDK v6 keys tool parts as `tool-{toolName}`
 * and exposes the resolved payload under `output` (not `result`, which
 * was the v4 name). We only consider parts in `output-available`
 * state — anything still streaming or in error has no payload to read.
 */
const collectPresentedFiles = (message: UIMessage): PresentedFileFromTool[] => {
  const collected: PresentedFileFromTool[] = [];
  for (const part of message.parts) {
    if (part.type !== "tool-presentFiles") continue;
    const recordPart = part as Record<string, unknown>;
    if (recordPart.state !== "output-available") continue;
    const output = recordPart.output;
    if (!output || typeof output !== "object") continue;
    const filesField = (output as Record<string, unknown>).files;
    if (!Array.isArray(filesField)) continue;
    for (const file of filesField) {
      if (!file || typeof file !== "object") continue;
      const f = file as Record<string, unknown>;
      const path = f.path;
      const filename = f.filename;
      const mimeType = f.mimeType;
      const size = f.size;
      if (
        typeof path !== "string" ||
        typeof filename !== "string" ||
        typeof mimeType !== "string" ||
        typeof size !== "number"
      ) {
        continue;
      }
      collected.push({ path, filename, mimeType, size });
    }
  }
  return collected;
};

/**
 * Pull the `askUserQuestion` tool questions off the assistant message
 * we are about to email. Mirrors the defensive narrowing of
 * `collectPresentedFiles` above. Returns `null` when the message does
 * NOT end on an `askUserQuestion` call — the caller then takes the
 * normal "chatbot finished replying" path.
 *
 * Source of truth for the shape: `tools/ask-user.ts` `QuestionSchema`
 * (question + header ≤ 12 chars + options[2-4] + multiSelect bool).
 * We re-validate every field here because the runtime payload is
 * `unknown` at the part boundary.
 */
const extractAskUserQuestion = (
  message: UIMessage,
): AskUserQuestionForEmail[] | null => {
  for (const part of message.parts) {
    if (part.type !== "tool-askUserQuestion") continue;
    const recordPart = part as Record<string, unknown>;
    if (recordPart.state !== "output-available") continue;
    const output = recordPart.output;
    if (!output || typeof output !== "object") continue;
    const questionsField = (output as Record<string, unknown>).questions;
    if (!Array.isArray(questionsField)) continue;

    const collected: AskUserQuestionForEmail[] = [];
    for (const raw of questionsField) {
      if (!raw || typeof raw !== "object") continue;
      const q = raw as Record<string, unknown>;
      const question = q.question;
      const header = q.header;
      const options = q.options;
      const multiSelect = q.multiSelect;
      if (
        typeof question !== "string" ||
        question.length === 0 ||
        typeof header !== "string" ||
        header.length === 0 ||
        !Array.isArray(options) ||
        options.length < 2 ||
        options.length > 4
      ) {
        continue;
      }
      const normalisedOptions: { label: string; description: string }[] = [];
      for (const opt of options) {
        if (!opt || typeof opt !== "object") continue;
        const o = opt as Record<string, unknown>;
        const label = o.label;
        const description = o.description;
        if (typeof label !== "string" || label.length === 0) continue;
        normalisedOptions.push({
          label,
          description: typeof description === "string" ? description : "",
        });
      }
      if (normalisedOptions.length < 2) continue;
      collected.push({
        question,
        header,
        options: normalisedOptions,
        multiSelect: multiSelect === true,
      });
    }

    if (collected.length > 0) return collected;
  }
  return null;
};

interface BuiltAttachment {
  name: string;
  type: string;
  /** base64-encoded content — what Scaleway expects on the wire. */
  content: string;
}

/**
 * Download the listed files from the conversation's S3 session mirror,
 * stop early if the running total exceeds the budget, and return the
 * encoded attachments plus a flag telling the generator to render the
 * "files too large" notice.
 *
 * We use the **raw** byte total to decide — even though the wire
 * payload will be base64. The cap already accounts for the encoding
 * blowup (see `MAX_ATTACHMENT_BYTES_TOTAL`). This keeps the budgeting
 * loop simple and lets us short-circuit before encoding huge buffers.
 */
const buildAttachments = async (
  conversationId: string,
  files: PresentedFileFromTool[],
  logPrefix: string,
): Promise<{ attachments: BuiltAttachment[]; oversized: boolean }> => {
  if (files.length === 0) return { attachments: [], oversized: false };

  let runningTotal = 0;
  for (const file of files) {
    runningTotal += file.size;
    if (runningTotal > MAX_ATTACHMENT_BYTES_TOTAL) {
      console.info(
        `${logPrefix} email-on-finish: total attachments (${runningTotal.toString()}B reported) exceed ${MAX_ATTACHMENT_BYTES_TOTAL.toString()}B cap — skipping attachments`,
      );
      return { attachments: [], oversized: true };
    }
  }

  const attachments: BuiltAttachment[] = [];
  for (const file of files) {
    const bytes = await readSessionFile(conversationId, file.path);
    if (!bytes) {
      console.warn(
        `${logPrefix} email-on-finish: missing S3 mirror for ${file.path} — skipping`,
      );
      continue;
    }
    attachments.push({
      name: sanitizeAttachmentFilename(file.filename),
      type: file.mimeType,
      content: Buffer.from(bytes).toString("base64"),
    });
  }
  return { attachments, oversized: false };
};

/**
 * Detect that the last assistant message ends with a python tool call
 * whose output is `{ status: "approval_pending", approvalId }`. Returns
 * the approvalId so the caller can fetch the row and build a dedicated
 * approval-pending email. Null = no pending approval in this turn.
 *
 * Symmetric with `extractAskUserQuestion` — both detect a turn-ending
 * stop condition that the user is supposed to act on, but they branch
 * to different email templates so the call-to-action matches.
 */
const extractApprovalPending = (message: UIMessage): string | null => {
  for (const part of message.parts) {
    if (part.type !== "tool-python") continue;
    const recordPart = part as Record<string, unknown>;
    if (recordPart.state !== "output-available") continue;
    const output = recordPart.output;
    if (!output || typeof output !== "object") continue;
    const status = (output as Record<string, unknown>).status;
    if (status !== "approval_pending") continue;
    const approvalId = (output as Record<string, unknown>).approvalId;
    if (typeof approvalId === "string") return approvalId;
  }
  return null;
};

interface SendChatbotFinishedEmailParams {
  conversationId: string;
  /**
   * The full message frame produced by the AI SDK during this turn.
   * We pick the LAST assistant message — older ones are history that
   * was already emailed (or that the user opted out of) on previous
   * turns.
   */
  finalMessages: UIMessage[];
  logPrefix: string;
}

/**
 * Fire the completion notification email if the conversation has
 * `emailOnCompletion = true`. No-op in every other case (toggle off,
 * conversation deleted, no owner, tool-only turn).
 *
 * Designed to be called fire-and-forget from the chatbot handler's
 * `onFinish` — every failure path logs and returns rather than
 * throwing, so a flaky email run never breaks the streaming response
 * the user already received.
 */
export const sendChatbotFinishedEmailIfEnabled = async (
  params: SendChatbotFinishedEmailParams,
): Promise<void> => {
  const { conversationId, finalMessages, logPrefix } = params;

  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: {
      id: true,
      teamId: true,
      title: true,
    },
    with: {
      // Email-on-completion is per-member: only participants who personally
      // opted in are notified. Each gets the same content, greeted by name.
      members: {
        where: { emailOnCompletion: true },
        with: { user: { columns: { email: true, name: true } } },
      },
    },
  });

  if (!conversation) {
    console.warn(
      `${logPrefix} email-on-finish: conversation ${conversationId} not found, skipping`,
    );
    return;
  }

  const recipients = conversation.members
    .map((m) => m.user)
    .filter((u): u is { email: string; name: string } => Boolean(u?.email));
  if (recipients.length === 0) return;

  const lastAssistant = [...finalMessages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastAssistant) return;

  /**
   * Send one rendered email to every opted-in recipient, greeting each by
   * their own name. The caller computes any expensive shared inputs
   * (attachments, summaries) once and only the lightweight template render
   * happens per recipient.
   */
  const sendToRecipients = async (
    build: (recipientName: string | null) => Promise<{
      subject: string;
      html: string;
      attachments?: BuiltAttachment[];
    }>,
    label: string,
  ): Promise<void> => {
    for (const recipient of recipients) {
      const { subject, html, attachments } = await build(recipient.name);
      await sendEmail({
        to: { email: recipient.email, name: recipient.name },
        subject,
        html,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
    }
    console.info(
      `${logPrefix} ${label} sent to ${recipients.length.toString()} recipient(s)`,
    );
  };

  // Branch 0 — turn paused on a write-plan approval gate.
  //
  // The chatbot agent's `stopWhen` includes `pythonAwaitingApproval`
  // (see `agents/chatbot/index.ts`), so any python tool returning
  // `{ status: "approval_pending", approvalId }` ends the turn there.
  // We branch BEFORE `askUserQuestion` (and before the generic
  // "finished" path) so the user gets the right call-to-action:
  // "review and approve" rather than "your assistant replied".
  //
  // Defensive checks:
  //   - approval row exists and belongs to this conversation
  //   - status is still `pending` — the user might have approved in
  //     another tab between the turn ending and this fire-and-forget
  //     callback running; in that case skip the email entirely
  //     (the approval flow is already complete on the other tab).
  const pendingApprovalId = extractApprovalPending(lastAssistant);
  if (pendingApprovalId !== null) {
    const approval = await db.query.toolApprovalRequests.findFirst({
      where: { id: pendingApprovalId },
      columns: {
        id: true,
        conversationId: true,
        status: true,
        summary: true,
      },
    });
    if (
      approval !== undefined &&
      approval.conversationId === conversationId &&
      approval.status === "pending"
    ) {
      const lang = await getTeamLocale(conversation.teamId);
      const rendered = renderApprovalSummary(approval.summary, lang);
      await sendToRecipients(
        (recipientName) =>
          generateChatbotApprovalPending({
            userName: recipientName,
            conversationId,
            conversationTitle: conversation.title,
            summary: rendered,
          }),
        "email-on-approval-pending",
      );
      return;
    }
  }

  // Branch 1 — turn stop-conditioned on `askUserQuestion`.
  //
  // The chatbot agent's `stopWhen` array includes
  // `hasToolCall("askUserQuestion")` (see
  // `agents/chatbot/index.ts`), so any turn that lands on that tool
  // ends immediately with no follow-up text. `extractAssistantMarkdown`
  // would return `""` in that case and the previous code path skipped
  // the email entirely — leaving users with `emailOnCompletion = true`
  // unaware that the conversation is paused waiting for their reply.
  //
  // We branch out BEFORE the markdown check: even if a future variant
  // produced some text in the same turn alongside the question, the
  // user's attention should go on the action that's required of them.
  const awaitingQuestions = extractAskUserQuestion(lastAssistant);
  if (awaitingQuestions !== null && awaitingQuestions.length > 0) {
    await sendToRecipients(
      (recipientName) =>
        generateChatbotFinishedAwaitingAnswers({
          userName: recipientName,
          conversationId,
          conversationTitle: conversation.title,
          questions: awaitingQuestions,
        }),
      "email-on-finish-awaiting",
    );
    return;
  }

  const assistantMarkdown = extractAssistantMarkdown(lastAssistant);
  if (assistantMarkdown.length === 0) {
    // Tool-only turn (e.g. the model called `manageTasks` and stopped)
    // with NO `askUserQuestion` either. No prose to email — silent.
    return;
  }

  // Build the attachments once — they're identical for every recipient.
  const presentedFiles = collectPresentedFiles(lastAssistant);
  const { attachments, oversized } = await buildAttachments(
    conversationId,
    presentedFiles,
    logPrefix,
  );

  await sendToRecipients(async (recipientName) => {
    const { subject, html } = await generateChatbotFinished({
      userName: recipientName,
      conversationId,
      conversationTitle: conversation.title,
      assistantMarkdown,
      oversizedAttachments: oversized,
    });
    return { subject, html, attachments };
  }, "email-on-finish");
};
