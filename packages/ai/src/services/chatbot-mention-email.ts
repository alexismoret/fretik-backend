import { generateChatbotMention } from "@fretik/shared/emails/generators";
import { sendEmail } from "@fretik/shared/lib/email";
import { getUserLocaleByEmail } from "@fretik/shared/services/auth/get-user-locale";
import type { TeamMember } from "@fretik/shared/services/team/members";

/**
 * Notify every teammate @mentioned in a user message that they were pulled
 * into a conversation. Fire-and-forget from the chatbot handler: each failure
 * is logged and swallowed so a flaky email run never breaks the turn.
 */
export const notifyMentionedMembers = async (params: {
  mentioned: TeamMember[];
  conversationId: string;
  conversationTitle: string;
  mentionedByName: string | null;
  logPrefix: string;
}): Promise<void> => {
  const {
    mentioned,
    conversationId,
    conversationTitle,
    mentionedByName,
    logPrefix,
  } = params;

  for (const member of mentioned) {
    if (!member.email) continue;
    try {
      const lang = await getUserLocaleByEmail(member.email);
      const { subject, html } = await generateChatbotMention(
        {
          userName: member.name,
          mentionedByName,
          conversationId,
          conversationTitle,
        },
        lang,
      );
      await sendEmail({
        to: { email: member.email, name: member.name },
        subject,
        html,
      });
    } catch (error) {
      console.warn(
        `${logPrefix} mention email to ${member.email} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (mentioned.length > 0) {
    console.info(
      `${logPrefix} mention emails sent to ${mentioned.length.toString()} recipient(s)`,
    );
  }
};
