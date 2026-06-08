import { pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Sign-up access control (closed beta). Self-serve sign-ups are restricted: a
 * user may only create an account if their email has a pending organization
 * invitation, appears in the per-email allowlist, OR matches an allowed
 * domain. Both tables are managed by a super-admin from the admin pages; the
 * `signup-gate` service reads them on every sign-up.
 */

/** Individually authorised emails. Stored lowercased. */
export const signupAllowlist = pgTable("signup_allowlist", {
  email: varchar("email").primaryKey(),
  note: text("note"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** Authorised email domains (e.g. `acme.com`). Stored lowercased, no `@`. */
export const signupAllowedDomains = pgTable("signup_allowed_domains", {
  domain: varchar("domain").primaryKey(),
  note: text("note"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});
