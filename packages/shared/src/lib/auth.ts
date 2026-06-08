import { redisStorage } from "@better-auth/redis-storage";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { emailOTP, organization, twoFactor } from "better-auth/plugins";
import db from "../db";
import * as schema from "../db/schema";
import {
  generateOrganizationInvitation,
  generateOtpEmail,
} from "../emails/generators";
import { bootstrapTeamWithBotUser } from "../services/auth/bot-user";
import {
  hasPendingInvitation,
  isEmailAllowlisted,
} from "../services/auth/signup-gate";
import { applyDocumentFieldTemplate } from "../services/field-definitions/apply-template";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";
import { OTP_EXPIRY_SECONDS } from "./auth-constants";
import { sendEmail } from "./email";
import { redis } from "./redis";

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw "Missing APP_URL env";
}

// When the API and AI services run on distinct subdomains of the same
// parent domain (e.g. api.fretik.com + ai.fretik.com), the session
// cookie must be scoped to the parent so the browser sends it to both.
// Set `COOKIE_DOMAIN=.fretik.com` (leading dot) in production. In dev,
// leave it unset — localhost cookies work across ports without this.
const cookieDomain = process.env.BETTER_AUTH_COOKIE_DOMAIN;

/**
 * Best-effort write to the auth security audit trail. Never throws into the
 * auth hot path — a failed audit insert is logged and swallowed.
 */
const recordAuthEvent = async (
  event: string,
  userId: string | null,
  details?: { ip?: string | null; userAgent?: string | null },
): Promise<void> => {
  try {
    await db.insert(schema.authAuditLog).values({
      event,
      userId,
      ip: details?.ip ?? null,
      userAgent: details?.userAgent ?? null,
    });
  } catch (err) {
    console.warn(`[auth-audit] failed to record ${event}:`, err);
  }
};

const options = {
  appName: "fretik",

  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  secondaryStorage: redisStorage({
    client: redis,
  }),
  verification: {
    storeIdentifier: "hashed",
  },

  advanced: {
    database: {
      generateId: () => Bun.randomUUIDv7(),
    },
    cookiePrefix: "fretik-",
    ...(cookieDomain && {
      crossSubDomainCookies: {
        enabled: true,
        domain: cookieDomain,
      },
    }),
  },

  basePath: "/auth",
  trustedOrigins: [appUrl],

  // NOTE: experimental.joins is intentionally disabled.
  // Better-Auth's drizzle adapter passes the output of convertWhereClause()
  // (raw Drizzle SQL expressions from eq()/and()/or()) into the relational
  // query API db.query.X.findFirst({ where: ... }). That API expects a
  // filter MAP ({ col: value, AND: [...] }), not a SQL object — so Drizzle
  // v2 Object.entries() the SQL and throws on its internal "decoder"
  // property: `Unknown relational filter field: "decoder"`. Re-enable only
  // once upstream patches the adapter or we move off the Drizzle v2 RC.

  emailAndPassword: {
    enabled: true,
    // Self-serve sign-ups must verify their email (via OTP — see the emailOTP
    // plugin). Invited users are auto-verified in the create hook below, so
    // this never blocks the invitation flow.
    requireEmailVerification: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      await recordAuthEvent("auth.password_reset", user.id);
    },
  },

  emailVerification: {
    // After the user verifies their email, sign them in automatically.
    autoSignInAfterVerification: true,
  },

  user: {
    deleteUser: {
      enabled: true,
    },
    additionalFields: {
      // Platform operator flag (cross-org). `input: false` makes Better Auth
      // reject it in any sign-up/update payload — it can only be written by the
      // super-admins service or the bootstrap script. Stored on the `user`
      // table (see auth-schema.ts) and surfaced on `session.user`, so guards
      // read the immutable flag, never the (mutable) email.
      isSuperAdmin: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },

  session: {
    // Window during which a session counts as "fresh" for sensitive actions
    // (e.g. deleting the account without re-entering the password).
    freshAge: 60 * 60,
  },

  rateLimit: {
    enabled: true,
    // Counters live in Redis (secondary storage) so limits hold across
    // instances. Better Auth already applies stricter defaults (3/10s) to
    // sensitive endpoints (sign-in, sign-up, ...).
    storage: "secondary-storage",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (newUser) => {
          const email = newUser.email.toLowerCase();
          // Invited users proved email ownership by clicking the emailed link
          // — auto-verify them so the invitation flow never stalls.
          if (await hasPendingInvitation(email)) {
            return { data: { ...newUser, emailVerified: true } };
          }
          // Closed beta: only allowlisted emails may self-register.
          if (!(await isEmailAllowlisted(email))) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-ups are invite-only during the beta.",
            });
          }
          return { data: newUser };
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          await recordAuthEvent("auth.sign_in", session.userId, {
            ip: session.ipAddress,
            userAgent: session.userAgent,
          });
        },
      },
    },
  },

  plugins: [
    organization({
      // The custom `generateId` (uuid v7) makes Better Auth treat invitation
      // IDs as "externally controlled", which would otherwise require a
      // verified email to accept/reject/get an invitation — blocking invited
      // users who have never verified. The emailed link is itself the
      // ownership proof, so disable that requirement.
      requireEmailVerificationOnInvitation: false,
      invitationExpiresIn: 60 * 60 * 24 * 7,
      cancelPendingInvitationsOnReInvite: true,
      organizationHooks: {
        afterCreateOrganization: async (data) => {
          await db.insert(schema.organizationSettings).values({
            organizationId: data.organization.id,
          });
          // Seed the org-scope document field definitions with the
          // default template. New teams created under this org inherit
          // this set at creation time.
          await applyDocumentFieldTemplate({
            organizationId: data.organization.id,
            teamId: null,
            templateKey: "default",
            mode: "replace",
          });
        },
        afterCreateTeam: async (data) => {
          await bootstrapTeamWithBotUser({
            teamId: data.team.id,
            organizationId: data.team.organizationId,
          });
          // Duplicate the org-scope field definitions into the new
          // team so the runtime reads always find a non-empty set.
          await duplicateOrgDefsToTeam({
            organizationId: data.team.organizationId,
            teamId: data.team.id,
          });
        },
      },

      sendInvitationEmail: async (data) => {
        const { subject, html } = await generateOrganizationInvitation({
          invitationId: data.id,
          inviterName: data.inviter.user.name,
          organizationName: data.organization.name,
          role: data.role,
          teamId: data.invitation.teamId,
          expiresAt: data.invitation.expiresAt,
        });

        await sendEmail({
          to: { email: data.email },
          subject,
          html,
        });
      },

      teams: {
        enabled: true,
        maximumTeams: async (data) => {
          const settings = await db.query.organizationSettings.findFirst({
            columns: { maxAgencies: true },
            where: { organizationId: data.organizationId },
          });
          return settings?.maxAgencies ?? 1;
        },
        maximumMembersPerTeam: 50,
        allowRemovingAllTeams: false,
      },
    }),

    emailOTP({
      // Email verification, password reset, and email change all use 6-digit
      // codes instead of magic links: codes survive corporate link-scanners
      // and keep the user in the same tab (SPA-friendly).
      overrideDefaultEmailVerification: true,
      sendVerificationOnSignUp: true,
      expiresIn: OTP_EXPIRY_SECONDS,
      allowedAttempts: 5,
      storeOTP: "hashed",
      changeEmail: { enabled: true },
      sendVerificationOTP: async ({ email, otp, type }) => {
        const { subject, html } = await generateOtpEmail(type, otp);
        void sendEmail({ to: { email }, subject, html });
      },
    }),

    twoFactor({
      issuer: "Fretik",
    }),
  ],
} satisfies BetterAuthOptions;

// `isSuperAdmin` is a typed `user.additionalField` (see the `user` block), so
// it rides on `session.user` natively — no customSession wrapper needed.
export const auth = betterAuth(options);
