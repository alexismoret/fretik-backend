import db from "../../db";
import {
  generateSecurityNoticeEmail,
  type SecurityNoticeKind,
} from "../../emails/generators";
import { sendEmail } from "../../lib/email";
import { normalizeLocale } from "../../lib/locales";
import { describeUserAgent } from "../../lib/user-agent";

/**
 * Email the account owner that a way to sign in to their account changed.
 * Best effort and fire-and-forget: a failed lookup or send is logged, never
 * surfaced to the request that triggered it.
 */
export const sendSecurityNotice = async (params: {
  userId: string;
  kind: SecurityNoticeKind;
  passkeyName: string | null;
  userAgent: string | null | undefined;
}): Promise<void> => {
  try {
    const recipient = await db.query.user.findFirst({
      columns: { name: true, email: true, language: true },
      where: { id: params.userId },
    });
    if (!recipient) return;

    const { subject, html } = await generateSecurityNoticeEmail(
      {
        kind: params.kind,
        userName: recipient.name,
        passkeyName: params.passkeyName,
        occurredAt: new Date(),
        device: describeUserAgent(params.userAgent),
      },
      normalizeLocale(recipient.language),
    );
    await sendEmail({
      to: { email: recipient.email, name: recipient.name },
      subject,
      html,
    });
  } catch (err) {
    console.warn(`[security-notice] failed to send ${params.kind}:`, err);
  }
};
