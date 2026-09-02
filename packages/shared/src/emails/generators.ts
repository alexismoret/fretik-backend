import db from "../db";
import type { RenderedApprovalSummary } from "../external-apps/i18n/render-summary";
import { OTP_EXPIRY_MINUTES } from "../lib/auth-constants";
import { i18n } from "./i18n";
import { renderMarkdownToEmailHtml } from "./markdown-to-html";
import { renderEmail } from "./render";

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw new Error("Missing APP_URL env");
}

/** BCP-47 tag for date formatting, derived from the email locale. */
const dateLocale = (lang: string): string =>
  lang === "fr" ? "fr-FR" : "en-US";

export interface EmailData {
  subject: string;
  html: string;
}

interface OrganizationInvitationParams {
  invitationId: string;
  inviterName: string;
  organizationName: string;
  role: string;
  teamId?: string | null;
  expiresAt: Date;
}

/**
 * Generate the email data for an organization invitation.
 * If a teamId is provided, the team name is fetched and displayed.
 * `lang` is the invitee's team language (falls back to `en`).
 */
export const generateOrganizationInvitation = async (
  params: OrganizationInvitationParams,
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const acceptUrl = `${appUrl}/invitation?id=${params.invitationId}`;

  let teamName: string | undefined;
  if (params.teamId) {
    const team = await db.query.team.findFirst({
      columns: { name: true },
      where: { id: params.teamId },
    });
    teamName = team?.name;
  }

  const message = teamName
    ? t("organizationInvitation.messageWithTeam", {
        inviterName: params.inviterName,
        teamName,
        organizationName: params.organizationName,
      })
    : t("organizationInvitation.message", {
        inviterName: params.inviterName,
        organizationName: params.organizationName,
      });

  const formattedExpiresAt = params.expiresAt.toLocaleDateString(
    dateLocale(lang),
    {
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );

  const html = await renderEmail(
    "organization-invitation",
    {
      greeting: t("organizationInvitation.greeting"),
      message,
      organizationLabel: t("organizationInvitation.organizationLabel", {
        organizationName: params.organizationName,
      }),
      teamLabel: teamName
        ? t("organizationInvitation.teamLabel", { teamName })
        : "",
      roleLabel: t("organizationInvitation.roleLabel", {
        roleName: params.role,
      }),
      acceptUrl,
      cta: t("organizationInvitation.cta"),
      expiration: t("organizationInvitation.expiration", {
        expiresAt: formattedExpiresAt,
      }),
      ignore: t("organizationInvitation.ignore"),
    },
    lang,
  );

  const subject = t("organizationInvitation.subject", {
    organizationName: params.organizationName,
  });

  return { subject, html };
};

/**
 * OTP email types emitted by the Better Auth email-otp plugin's
 * `sendVerificationOTP({ type })` callback.
 */
type OtpEmailType =
  "sign-in" | "email-verification" | "forget-password" | "change-email";

/**
 * Build a one-time-password email (email verification, password reset, or
 * sign-in). The email-otp plugin calls this from its single
 * `sendVerificationOTP` callback; `type` selects the copy. Expiry copy is
 * derived from the shared `OTP_EXPIRY_MINUTES` so it always matches the
 * plugin's `expiresIn`. `lang` is the recipient's stored language.
 */
export const generateOtpEmail = async (
  type: OtpEmailType,
  otp: string,
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const copyKey =
    type === "forget-password"
      ? "otp.forgetPassword"
      : type === "sign-in"
        ? "otp.signIn"
        : type === "change-email"
          ? "otp.changeEmail"
          : "otp.emailVerification";

  const html = await renderEmail(
    "email-otp",
    {
      greeting: t("otp.greeting"),
      intro: t(`${copyKey}.intro`),
      codeLabel: t("otp.codeLabel"),
      code: otp,
      expiration: t("otp.expiration", {
        minutes: String(OTP_EXPIRY_MINUTES),
      }),
      ignore: t("otp.ignore"),
    },
    lang,
  );

  return { subject: t(`${copyKey}.subject`), html };
};

interface ChatbotFinishedParams {
  /** Display name of the user receiving the email. Falls back to a generic greeting when null/empty. */
  userName: string | null;
  conversationId: string;
  /** Conversation title from `ai_conversations.title`. May be empty/null before the first auto-rename. */
  conversationTitle: string | null;
  /** Final assistant turn content as Markdown — converted to email-safe HTML inline. */
  assistantMarkdown: string;
  /** True when the presentFiles outputs were too large to attach (rendered as a footer notice). */
  oversizedAttachments: boolean;
}

/**
 * Build the "chatbot finished replying" email.
 *
 * The assistant Markdown is rendered to HTML with inline styles (so Outlook
 * and Gmail's prose-stripping does not erase it), then injected into the
 * MJML template via Handlebars' triple-stache. Pair with `sendEmail` from
 * `@fretik/shared/lib/email`, optionally with `attachments` built from any
 * `presentFiles` outputs. `lang` is the recipient's stored language.
 */
export const generateChatbotFinished = async (
  params: ChatbotFinishedParams,
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const conversationUrl = `${appUrl}/chatbot/${params.conversationId}`;
  const trimmedTitle = params.conversationTitle?.trim();
  const title =
    trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : t("chatbotFinished.untitledConversation");

  const trimmedName = params.userName?.trim();
  const greeting =
    trimmedName && trimmedName.length > 0
      ? t("chatbotFinished.greetingNamed", { name: trimmedName })
      : t("chatbotFinished.greetingAnonymous");

  const assistantHtml = renderMarkdownToEmailHtml(
    params.assistantMarkdown,
    appUrl,
  );

  const html = await renderEmail(
    "chatbot-finished",
    {
      greeting,
      intro: t("chatbotFinished.intro", { conversationTitle: title }),
      conversationUrl,
      cta: t("chatbotFinished.cta"),
      replyHeader: t("chatbotFinished.replyHeader"),
      assistantHtml,
      oversizedAttachmentsNotice: params.oversizedAttachments
        ? t("chatbotFinished.oversizedAttachments")
        : "",
    },
    lang,
  );

  const subject = t("chatbotFinished.subject", {
    conversationTitle: title,
  });

  return { subject, html };
};

interface ChatbotMentionParams {
  /** Display name of the mentioned user receiving the email. */
  userName: string | null;
  /** Display name of the teammate who wrote the @mention. */
  mentionedByName: string | null;
  conversationId: string;
  /** Conversation title from `ai_conversations.title`. May be empty/null. */
  conversationTitle: string | null;
}

/**
 * Build the "a teammate mentioned you" email, sent when a user is @mentioned
 * in a collaborative conversation. Pulls the recipient straight into the
 * thread via the CTA. `lang` is the recipient's stored language.
 */
export const generateChatbotMention = async (
  params: ChatbotMentionParams,
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const conversationUrl = `${appUrl}/chatbot/${params.conversationId}`;
  const trimmedTitle = params.conversationTitle?.trim();
  const title =
    trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : t("chatbotMention.untitledConversation");

  const trimmedName = params.userName?.trim();
  const greeting =
    trimmedName && trimmedName.length > 0
      ? t("chatbotMention.greetingNamed", { name: trimmedName })
      : t("chatbotMention.greetingAnonymous");

  const mentionedBy =
    params.mentionedByName?.trim() || t("chatbotMention.someone");

  const html = await renderEmail(
    "chatbot-mention",
    {
      greeting,
      intro: t("chatbotMention.intro", {
        mentionedBy,
        conversationTitle: title,
      }),
      conversationUrl,
      cta: t("chatbotMention.cta"),
    },
    lang,
  );

  const subject = t("chatbotMention.subject", { mentionedBy });

  return { subject, html };
};

/**
 * One question shape consumed by the awaiting-answers email.
 *
 * Mirrors the runtime payload produced by the `askUserQuestion` tool
 * (`backend/packages/ai/src/tools/ask-user.ts` — `QuestionSchema`).
 * Exported so the chatbot-side collection helper can build a typed
 * `questions[]` without re-declaring the shape.
 */
export interface AskUserQuestionForEmail {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

interface ChatbotFinishedAwaitingAnswersParams {
  /** Display name of the user receiving the email. Falls back to a generic greeting when null/empty. */
  userName: string | null;
  conversationId: string;
  /** Conversation title from `ai_conversations.title`. May be empty/null before the first auto-rename. */
  conversationTitle: string | null;
  /** 1-4 questions captured from the `askUserQuestion` tool call that ended the turn. */
  questions: AskUserQuestionForEmail[];
}

/**
 * Build the "chatbot is waiting for your answer" email.
 *
 * Triggered when the assistant turn ends on a `tool-askUserQuestion`
 * call (via the `hasToolCall("askUserQuestion")` stop condition). The
 * UI presents the questions inline through `ToolAskUserQuestion.vue`,
 * but users who enabled `emailOnCompletion` would otherwise miss the
 * pending prompt — this email surfaces the questions + options so they
 * know the conversation needs their input to resume. `lang` is the
 * recipient's stored language.
 */
export const generateChatbotFinishedAwaitingAnswers = async (
  params: ChatbotFinishedAwaitingAnswersParams,
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const conversationUrl = `${appUrl}/chatbot/${params.conversationId}`;
  const trimmedTitle = params.conversationTitle?.trim();
  const title =
    trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : t("chatbotFinishedAwaitingAnswers.untitledConversation");

  const trimmedName = params.userName?.trim();
  const greeting =
    trimmedName && trimmedName.length > 0
      ? t("chatbotFinishedAwaitingAnswers.greetingNamed", {
          name: trimmedName,
        })
      : t("chatbotFinishedAwaitingAnswers.greetingAnonymous");

  const html = await renderEmail(
    "chatbot-finished-awaiting-answers",
    {
      greeting,
      intro: t("chatbotFinishedAwaitingAnswers.intro", {
        conversationTitle: title,
      }),
      conversationUrl,
      cta: t("chatbotFinishedAwaitingAnswers.cta"),
      questionsHeader: t("chatbotFinishedAwaitingAnswers.questionsHeader"),
      multiSelectHint: t("chatbotFinishedAwaitingAnswers.multiSelectHint"),
      freeTextHint: t("chatbotFinishedAwaitingAnswers.freeTextHint"),
      questions: params.questions,
    },
    lang,
  );

  const subject = t("chatbotFinishedAwaitingAnswers.subject", {
    conversationTitle: title,
  });

  return { subject, html };
};

interface WorkflowRunEmailBaseParams {
  /** Display name of the user receiving the email. Falls back to a generic greeting when null/empty. */
  userName: string | null;
  workflowId: string;
  runId: string;
  workflowName: string;
}

/** Deep link to the run: the workflow page seeds its selected run from the
 * `run` query param (`pages/workflows/[id].vue`). */
const workflowRunUrl = (params: WorkflowRunEmailBaseParams): string =>
  `${appUrl}/workflows/${params.workflowId}?run=${params.runId}`;

const workflowGreeting = (
  userName: string | null,
  t: ReturnType<typeof i18n.getFixedT>,
  keyPrefix: string,
): string => {
  const trimmedName = userName?.trim();
  return trimmedName && trimmedName.length > 0
    ? t(`${keyPrefix}.greetingNamed`, { name: trimmedName })
    : t(`${keyPrefix}.greetingAnonymous`);
};

/**
 * Build the "workflow run finished" email, sent to the recipients configured
 * in `workflows.notifications` when a run succeeds. The final summary
 * Markdown is rendered to email-safe HTML; produced files ride along as
 * attachments built by the caller. `lang` is the recipient's stored language.
 */
export const generateWorkflowRunFinished = async (
  params: WorkflowRunEmailBaseParams & {
    /** Final assistant summary as Markdown. Empty = no result box. */
    outputSummaryMarkdown: string;
    /** True when the run's files were too large to attach (rendered as a footer notice). */
    oversizedAttachments: boolean;
  },
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const trimmedSummary = params.outputSummaryMarkdown.trim();

  const html = await renderEmail(
    "workflow-run-finished",
    {
      greeting: workflowGreeting(params.userName, t, "workflowRunFinished"),
      intro: t("workflowRunFinished.intro", {
        workflowName: params.workflowName,
      }),
      runUrl: workflowRunUrl(params),
      cta: t("workflowRunFinished.cta"),
      resultHeader: t("workflowRunFinished.resultHeader"),
      summaryHtml:
        trimmedSummary.length > 0
          ? renderMarkdownToEmailHtml(trimmedSummary, appUrl)
          : "",
      oversizedAttachmentsNotice: params.oversizedAttachments
        ? t("workflowRunFinished.oversizedAttachments")
        : "",
    },
    lang,
  );

  const subject = t("workflowRunFinished.subject", {
    workflowName: params.workflowName,
  });

  return { subject, html };
};

/**
 * Build the "workflow run failed" email. Surfaces the run error (code +
 * message) plus the last summary when the agent produced one before dying,
 * so the recipient can triage without opening the app. `lang` is the
 * recipient's stored language.
 */
export const generateWorkflowRunFailed = async (
  params: WorkflowRunEmailBaseParams & {
    errorCode: string | null;
    errorMessage: string | null;
    /** Last assistant summary, when the run produced one before failing. */
    outputSummaryMarkdown: string | null;
  },
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const trimmedSummary = params.outputSummaryMarkdown?.trim() ?? "";

  const html = await renderEmail(
    "workflow-run-failed",
    {
      greeting: workflowGreeting(params.userName, t, "workflowRunFailed"),
      intro: t("workflowRunFailed.intro", {
        workflowName: params.workflowName,
      }),
      runUrl: workflowRunUrl(params),
      cta: t("workflowRunFailed.cta"),
      errorHeader: t("workflowRunFailed.errorHeader"),
      errorCode: params.errorCode ?? "",
      errorMessage:
        params.errorMessage?.trim() || t("workflowRunFailed.unknownError"),
      resultHeader: t("workflowRunFailed.resultHeader"),
      summaryHtml:
        trimmedSummary.length > 0
          ? renderMarkdownToEmailHtml(trimmedSummary, appUrl)
          : "",
    },
    lang,
  );

  const subject = t("workflowRunFailed.subject", {
    workflowName: params.workflowName,
  });

  return { subject, html };
};

/**
 * Build the "workflow run needs your approval" email, sent when a run parks
 * in `needs_approval`. Kind-aware detail: an external-app plan renders its
 * localized operation list (`summary`), an `askUserQuestion` park renders
 * the questions, anything else falls back to a generic "open the run" line.
 * `lang` is the recipient's stored language and must match the language the
 * `summary` was rendered in.
 */
export const generateWorkflowRunApproval = async (
  params: WorkflowRunEmailBaseParams & {
    /** Localized plan summary (external-app plans only). */
    summary?: RenderedApprovalSummary;
    /** Questions captured from an `askUserQuestion` park. */
    questions?: AskUserQuestionForEmail[];
  },
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const operations = params.summary?.operations.map((op) => ({
    title: op.title,
  }));
  const hasDetail =
    (operations && operations.length > 0) ||
    (params.questions && params.questions.length > 0);

  const html = await renderEmail(
    "workflow-run-approval",
    {
      greeting: workflowGreeting(params.userName, t, "workflowRunApproval"),
      intro: t("workflowRunApproval.intro", {
        workflowName: params.workflowName,
      }),
      runUrl: workflowRunUrl(params),
      cta: t("workflowRunApproval.cta"),
      planHeader: params.summary?.title ?? "",
      operations: operations ?? [],
      questionsHeader: t("workflowRunApproval.questionsHeader"),
      multiSelectHint: t("workflowRunApproval.multiSelectHint"),
      questions: params.questions ?? [],
      genericDetail: hasDetail ? "" : t("workflowRunApproval.genericDetail"),
    },
    lang,
  );

  const subject = t("workflowRunApproval.subject", {
    workflowName: params.workflowName,
  });

  return { subject, html };
};

interface ChatbotApprovalPendingParams {
  /** Display name of the user receiving the email. Falls back to a generic greeting when null/empty. */
  userName: string | null;
  conversationId: string;
  /** Conversation title from `ai_conversations.title`. May be empty/null before the first auto-rename. */
  conversationTitle: string | null;
  /**
   * Translated approval summary built via
   * `renderApprovalSummary(approval.summary, lang)`. The template uses
   * `.title` for the header and the per-op `.title` strings for the
   * numbered list — fields are deliberately omitted to keep the email
   * scannable on mobile; the CTA sends the user to the chat where the
   * full card has the per-op details.
   */
  summary: RenderedApprovalSummary;
}

/**
 * Build the "plan awaiting your approval" email.
 *
 * Triggered when the assistant turn ends with a python tool call that
 * raised `ApprovalPending` — i.e. the agent submitted a write plan via
 * `run_plan(...)` and stopped pending the user's decision. Mirrors the
 * "awaiting answers" pattern: surfaces the action needed and links back
 * to the conversation so the user can review and approve in the card.
 * `lang` is the recipient's stored language and must match the language
 * the `summary` was rendered in.
 */
export const generateChatbotApprovalPending = async (
  params: ChatbotApprovalPendingParams,
  lang: string,
): Promise<EmailData> => {
  const t = i18n.getFixedT(lang);
  const conversationUrl = `${appUrl}/chatbot/${params.conversationId}`;
  const trimmedTitle = params.conversationTitle?.trim();
  const title =
    trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : t("chatbotApprovalPending.untitledConversation");

  const trimmedName = params.userName?.trim();
  const greeting =
    trimmedName && trimmedName.length > 0
      ? t("chatbotApprovalPending.greetingNamed", { name: trimmedName })
      : t("chatbotApprovalPending.greetingAnonymous");

  const html = await renderEmail(
    "chatbot-approval-pending",
    {
      greeting,
      intro: t("chatbotApprovalPending.intro", { conversationTitle: title }),
      conversationUrl,
      cta: t("chatbotApprovalPending.cta"),
      planHeader: params.summary.title,
      operations: params.summary.operations.map((op) => ({ title: op.title })),
    },
    lang,
  );

  const subject = t("chatbotApprovalPending.subject", {
    conversationTitle: title,
  });

  return { subject, html };
};
