import { desc, eq } from "drizzle-orm";

import db from "../../db";
import { signupAllowedDomains, signupAllowlist } from "../../db/schema";

/**
 * CRUD for the closed-beta sign-up access lists (`signup_allowlist` and
 * `signup_allowed_domains`). Managed by super-admins via `/signup-access`.
 * Values are stored lowercased so they match the `signup-gate` lookup and
 * Better Auth's normalised user email.
 */

// --- Allowed emails --------------------------------------------------------

export const listAllowlist = async () =>
  db
    .select({
      email: signupAllowlist.email,
      note: signupAllowlist.note,
      createdAt: signupAllowlist.createdAt,
    })
    .from(signupAllowlist)
    .orderBy(desc(signupAllowlist.createdAt));

export const addToAllowlist = async (
  email: string,
  note?: string | null,
): Promise<string> => {
  const normalized = email.trim().toLowerCase();
  await db
    .insert(signupAllowlist)
    .values({ email: normalized, note: note ?? null })
    .onConflictDoUpdate({
      target: signupAllowlist.email,
      set: { note: note ?? null },
    });
  return normalized;
};

export const removeFromAllowlist = async (email: string): Promise<void> => {
  await db
    .delete(signupAllowlist)
    .where(eq(signupAllowlist.email, email.trim().toLowerCase()));
};

// --- Allowed domains -------------------------------------------------------

/** Normalise a domain: lowercase, trimmed, leading `@` stripped. */
const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/^@/, "");

export const listAllowedDomains = async () =>
  db
    .select({
      domain: signupAllowedDomains.domain,
      note: signupAllowedDomains.note,
      createdAt: signupAllowedDomains.createdAt,
    })
    .from(signupAllowedDomains)
    .orderBy(desc(signupAllowedDomains.createdAt));

export const addAllowedDomain = async (
  domain: string,
  note?: string | null,
): Promise<string> => {
  const normalized = normalizeDomain(domain);
  await db
    .insert(signupAllowedDomains)
    .values({ domain: normalized, note: note ?? null })
    .onConflictDoUpdate({
      target: signupAllowedDomains.domain,
      set: { note: note ?? null },
    });
  return normalized;
};

export const removeAllowedDomain = async (domain: string): Promise<void> => {
  await db
    .delete(signupAllowedDomains)
    .where(eq(signupAllowedDomains.domain, normalizeDomain(domain)));
};
