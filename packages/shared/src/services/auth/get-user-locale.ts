import db from "../../db";
import { normalizeLocale, type SupportedLocale } from "../../lib/locales";

/**
 * The stored UI language of the user with this email, normalized to a
 * supported locale (fallback `en`). Used by the OTP email callback — which
 * only receives an email address — to localize verification / password-reset
 * / sign-in emails to the recipient's preference. Returns the default locale
 * when no matching user exists (e.g. the new address of a `change-email` OTP).
 */
export const getUserLocaleByEmail = async (
  email: string,
): Promise<SupportedLocale> => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return normalizeLocale(null);

  const row = await db.query.user.findFirst({
    columns: { language: true },
    where: { email: normalized },
  });

  return normalizeLocale(row?.language);
};
