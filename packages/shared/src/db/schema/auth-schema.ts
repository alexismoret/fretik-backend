import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: uuid("id")
    .default(sql`uuid_generate_v7()`)
    .primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  // Added by the Better Auth `twoFactor` plugin (see twoFactor table below).
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  // Platform operator flag (cross-org) — grants access to the admin pages
  // (sign-up access, super-admins). Storage column for the Better Auth
  // `user.additionalFields.isSuperAdmin` (declared `input: false` so it can
  // never be set through a sign-up/update payload). Granted only via the
  // super-admins service or the one-off `grant:super-admin` bootstrap script.
  isSuperAdmin: boolean("is_super_admin").default(false).notNull(),
  // UI language preference (BCP-47 short code, e.g. "en"/"fr"). Storage column
  // for the Better Auth `user.additionalFields.language`. Set at sign-up from
  // the inviting team's language (see the `user.create.before` hook), then
  // user-settable from the profile settings. The app applies it via i18n on
  // load; the DB value is the source of truth for authenticated sessions.
  language: varchar("language", { length: 8 }).default("en").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const account = pgTable(
  "account",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    accountId: text("account_id").notNull(),
    /**
     * Legacy. Better Auth 1.7.0–1.7.2 required it (`local:credential` for a
     * password account); 1.7.3 dropped it and identifies an account by
     * `(providerId, accountId)` again, as in 1.6 — see the compound index
     * below. New rows leave it NULL, which is why it is nullable: a NOT NULL
     * column Better Auth never writes rejects every sign-up. Kept rather than
     * dropped so a replica still running 1.7.2 during a rolling deploy can
     * keep writing it; drop it once no 1.7.2 code is left anywhere.
     */
    issuer: text("issuer"),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    // Better Auth refuses an account lookup that matches more than one row;
    // this makes that impossible rather than merely unlikely.
    uniqueIndex("account_providerId_accountId_uidx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const organization = pgTable(
  "organization",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    metadata: text("metadata"),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
);

export const team = pgTable(
  "team",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    name: text("name").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Cached team size, maintained by Better Auth 1.7 so the seat limit
     * (`teams.maximumMembersPerTeam`) can be enforced without counting rows on
     * every add. Never written by application code.
     */
    memberCount: integer("member_count").default(0).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    }).$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [index("team_organizationId_idx").on(table.organizationId)],
);

export const teamMember = pgTable(
  "team_member",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Better Auth 1.7's single-column uniqueness boundary for a user within a
     * team: base64url(sha256(JSON.stringify([teamId, userId]))). Nullable
     * because rows created before 1.7 have none, and the lookup falls back to
     * the (teamId, userId) pair when the key misses.
     */
    membershipKey: text("membership_key").unique(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("teamMember_teamId_idx").on(table.teamId),
    index("teamMember_userId_idx").on(table.userId),
  ],
);

export const member = pgTable(
  "member",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    /**
     * One membership per person per organization.
     *
     * Better Auth's accept-invitation endpoint ends in an unconditional
     * `createMember()`, so an existing member accepting an invitation would
     * write a SECOND row here — and every role lookup in this codebase is
     * `findFirst`-shaped (`services/organization/member-role.ts`,
     * `lib/auth-roles.ts`), which would make that person's role whichever row
     * Postgres happened to return. `lib/auth-hooks.ts` closes the one path
     * that could reach it; this closes the class.
     *
     * Note the consequence: a duplicate insert is now an error, not a bad
     * row. That is the trade — `createMember` does no conflict handling, so
     * the failure surfaces loudly at the call site instead of silently
     * corrupting authorization.
     */
    uniqueIndex("member_organizationId_userId_uidx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    teamId: uuid("team_id"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

// Added by the Better Auth `twoFactor` plugin. One row per user enrolled in
// TOTP; `verified` flips to true after the first successful verification and
// `user.twoFactorEnabled` mirrors it. Id follows this codebase's uuid v7
// convention; `user_id` is `uuid` to match the `user.id` it references.
export const twoFactor = pgTable(
  "two_factor",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull(),
    // Added by the Better Auth `twoFactor` plugin's account-lockout feature
    // (1.6.23). Shared across TOTP/OTP/backup-code challenges; a successful
    // verification resets the counter.
    failedVerificationCount: integer("failed_verification_count")
      .default(0)
      .notNull(),
    lockedUntil: timestamp("locked_until", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [index("twoFactor_userId_idx").on(table.userId)],
);

// Added by the Better Auth `passkey` plugin (`@better-auth/passkey`). One row
// per WebAuthn credential; a user may hold several (one per password manager
// or security key). Id follows this codebase's uuid v7 convention; `user_id`
// is `uuid` to match the `user.id` it references.
export const passkey = pgTable(
  "passkey",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    // User-chosen label. Filled at registration with the authenticator's
    // provider name (see `lib/auth-passkey.ts`), renameable afterwards.
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // base64url credential id. Sign-in looks the credential up by it, and two
    // rows sharing one would make that lookup ambiguous: unique, not just
    // indexed.
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    // `singleDevice` (a security key) or `multiDevice` (a synced passkey).
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    // Authenticator model (Google Password Manager, 1Password, ...). All-zero
    // when the platform hides it (Apple under `attestation: "none"`).
    aaguid: text("aaguid"),
    // Not a Better Auth field: stamped by `authentication.afterVerification`
    // on every passkey sign-in and read by the security settings list. Better
    // Auth never selects or writes it, so the plugin stays unaware of it.
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("passkey_userId_idx").on(table.userId),
    uniqueIndex("passkey_credentialID_uidx").on(table.credentialID),
  ],
);
