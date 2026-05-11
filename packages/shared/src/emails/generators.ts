import db from "../db";
import { i18n } from "./i18n";
import { renderMarkdownToEmailHtml } from "./markdown-to-html";
import { renderEmail } from "./render";

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw "Missing APP_URL env";
}

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
 */
export const generateOrganizationInvitation = async (
  params: OrganizationInvitationParams,
): Promise<EmailData> => {
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
    ? i18n.t("organizationInvitation.messageWithTeam", {
        inviterName: params.inviterName,
        teamName,
        organizationName: params.organizationName,
      })
    : i18n.t("organizationInvitation.message", {
        inviterName: params.inviterName,
        organizationName: params.organizationName,
      });

  const formattedExpiresAt = params.expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = await renderEmail("organization-invitation", {
    greeting: i18n.t("organizationInvitation.greeting"),
    message,
    organizationLabel: i18n.t("organizationInvitation.organizationLabel", {
      organizationName: params.organizationName,
    }),
    teamLabel: teamName
      ? i18n.t("organizationInvitation.teamLabel", { teamName })
      : "",
    roleLabel: i18n.t("organizationInvitation.roleLabel", {
      roleName: params.role,
    }),
    acceptUrl,
    cta: i18n.t("organizationInvitation.cta"),
    expiration: i18n.t("organizationInvitation.expiration", {
      expiresAt: formattedExpiresAt,
    }),
    ignore: i18n.t("organizationInvitation.ignore"),
  });

  const subject = i18n.t("organizationInvitation.subject", {
    organizationName: params.organizationName,
  });

  return { subject, html };
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
 * `presentFiles` outputs.
 */
export const generateChatbotFinished = async (
  params: ChatbotFinishedParams,
): Promise<EmailData> => {
  const conversationUrl = `${appUrl}/chatbot/${params.conversationId}`;
  const trimmedTitle = params.conversationTitle?.trim();
  const title =
    trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : i18n.t("chatbotFinished.untitledConversation");

  const trimmedName = params.userName?.trim();
  const greeting =
    trimmedName && trimmedName.length > 0
      ? i18n.t("chatbotFinished.greetingNamed", { name: trimmedName })
      : i18n.t("chatbotFinished.greetingAnonymous");

  const assistantHtml = renderMarkdownToEmailHtml(
    params.assistantMarkdown,
    appUrl,
  );

  const html = await renderEmail("chatbot-finished", {
    greeting,
    intro: i18n.t("chatbotFinished.intro", { conversationTitle: title }),
    conversationUrl,
    cta: i18n.t("chatbotFinished.cta"),
    replyHeader: i18n.t("chatbotFinished.replyHeader"),
    assistantHtml,
    oversizedAttachmentsNotice: params.oversizedAttachments
      ? i18n.t("chatbotFinished.oversizedAttachments")
      : "",
  });

  const subject = i18n.t("chatbotFinished.subject", {
    conversationTitle: title,
  });

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
 * know the conversation needs their input to resume.
 */
export const generateChatbotFinishedAwaitingAnswers = async (
  params: ChatbotFinishedAwaitingAnswersParams,
): Promise<EmailData> => {
  const conversationUrl = `${appUrl}/chatbot/${params.conversationId}`;
  const trimmedTitle = params.conversationTitle?.trim();
  const title =
    trimmedTitle && trimmedTitle.length > 0
      ? trimmedTitle
      : i18n.t("chatbotFinishedAwaitingAnswers.untitledConversation");

  const trimmedName = params.userName?.trim();
  const greeting =
    trimmedName && trimmedName.length > 0
      ? i18n.t("chatbotFinishedAwaitingAnswers.greetingNamed", {
          name: trimmedName,
        })
      : i18n.t("chatbotFinishedAwaitingAnswers.greetingAnonymous");

  const html = await renderEmail("chatbot-finished-awaiting-answers", {
    greeting,
    intro: i18n.t("chatbotFinishedAwaitingAnswers.intro", {
      conversationTitle: title,
    }),
    conversationUrl,
    cta: i18n.t("chatbotFinishedAwaitingAnswers.cta"),
    questionsHeader: i18n.t("chatbotFinishedAwaitingAnswers.questionsHeader"),
    multiSelectHint: i18n.t("chatbotFinishedAwaitingAnswers.multiSelectHint"),
    freeTextHint: i18n.t("chatbotFinishedAwaitingAnswers.freeTextHint"),
    questions: params.questions,
  });

  const subject = i18n.t("chatbotFinishedAwaitingAnswers.subject", {
    conversationTitle: title,
  });

  return { subject, html };
};
