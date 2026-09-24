import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { electron } from "@better-auth/electron";
import { passkey } from "@better-auth/passkey";
import { redisStorage } from "@better-auth/redis-storage";
import { APIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { emailOTP, organization, twoFactor } from "better-auth/plugins";
import db from "../db";
import * as schema from "../db/schema";
import { generateOtpEmail } from "../emails/generators";
import { getUserLocaleByEmail } from "../services/auth/get-user-locale";
import {
  findSignupInvitation,
  isEmailAllowlisted,
  SIGNUP_INVITATION_HEADER,
} from "../services/auth/signup-gate";
import { seedStarterCollections } from "../services/collections/seed-starter-types";
import { seedSystemOntology } from "../services/collections/seed-system-types";
import { applyDocumentFieldTemplate } from "../services/field-definitions/apply-template";
import { getTeamLocale } from "../services/field-definitions/get-locale";
import { sendOrganizationInvitationEmail } from "../services/invitations/send-invitation-email";
import { withdrawInvitationsToDeletedTeam } from "../services/invitations/withdraw-for-deleted-team";
import { maximumTeamsFor } from "../services/organization/team-limit";
import { scrubWorkflowNotificationRecipient } from "../services/workflows/scrub-notification-recipient";
import { accountSecurity } from "./auth-account-security";
import { recordAuthEvent } from "./auth-audit";
import {
  INVITATION_EXPIRY_SECONDS,
  MAX_MEMBERS_PER_TEAM,
  OTP_EXPIRY_SECONDS,
  PENDING_INVITATION_LIMIT,
} from "./auth-constants";
import { organizationTeamInvitationHooks } from "./auth-hooks";
import {
  journalAfterTheFact,
  onMemberLeftOrganization,
  onMemberLeftTeam,
  onMembershipChanged,
  onTeamCreated,
  organizationMembershipAfterHooks,
} from "./auth-membership";
import { passkeyOptions } from "./auth-passkey";
import { sendEmail } from "./email";
import { redis } from "./redis";

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw new Error("Missing APP_URL env");
}

// When the API and AI services run on distinct subdomains of the same
// parent domain (e.g. api.fretik.com + ai.fretik.com), the session
// cookie must be scoped to the parent so the browser sends it to both.
// Set `COOKIE_DOMAIN=.fretik.com` (leading dot) in production. In dev,
// leave it unset — localhost cookies work across ports without this.
const cookieDomain = process.env.BETTER_AUTH_COOKIE_DOMAIN;

// Desktop (Electron) app origins that must be trusted alongside the web app.
// The main-process Better Auth client tags its requests with
// `electron-origin: <scheme>:/` (the electron() plugin promotes it to Origin),
// and the renderer loads the SPA from `app://fretik` — so both are trusted here.
const electronScheme = process.env.ELECTRON_PROTOCOL_SCHEME ?? "com.fretik.app";
const electronOrigins = [`${electronScheme}:/`, "app://fretik"];

/**
 * Best-effort scrub of workflow email-recipient lists when a user deletes
 * their account. Never blocks the deletion — the send path re-checks the team
 * roster anyway (`filterTeamMemberIds`), so a missed scrub can't leak an
 * email. Leaving a team or the organization is handled in
 * `auth-membership.ts`.
 */
const scrubNotificationRecipient = async (params: {
  userId: string;
}): Promise<void> => {
  try {
    await scrubWorkflowNotificationRecipient(params);
  } catch (err) {
    console.warn(
      `[workflow-notifications] failed to scrub recipient ${params.userId}:`,
      err,
    );
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
      /**
       * Fetch related rows in one query instead of N. `/get-session` and
       * `/get-full-organization` are the big winners (2-3x per the upstream
       * docs), and both are on every page load.
       *
       * This was unusable until 1.7: the old `better-auth/adapters/drizzle`
       * fed raw SQL expressions from convertWhereClause() into Drizzle v2's
       * relational query API, which wants a filter MAP — so v2 walked the SQL
       * object and threw on its internal "decoder" property. The dedicated
       * `@better-auth/drizzle-adapter/relations-v2` entry point above speaks
       * v2 natively and is what makes this safe to turn on.
       */
      joins: true,
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
  trustedOrigins: [appUrl, ...electronOrigins],

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
      afterDelete: async (user) => {
        await scrubNotificationRecipient({ userId: user.id });
      },
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
      // UI language preference. User-settable (input allowed) via
      // `updateUser({ language })`. Set at sign-up from the inviting team's
      // language in the `user.create.before` hook below; defaults to "en"
      // for self-serve sign-ups. Rides on `session.user` so the frontend
      // applies it via i18n on load.
      language: {
        type: "string",
        required: false,
        defaultValue: "en",
      },
    },
  },

  session: {
    // Window during which a session counts as "fresh" for sensitive actions
    // (e.g. deleting the account without re-entering the password, adding a
    // passkey). Past it, `POST /security/reauthenticate` renews it in place.
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
      // The sign-in page asks for passkey options on every visit (browser
      // autofill), hence a roomier budget than the ceremony it precedes.
      "/passkey/generate-authenticate-options": { window: 60, max: 30 },
      "/passkey/verify-authentication": { window: 60, max: 10 },
      "/passkey/generate-register-options": { window: 60, max: 10 },
      "/passkey/verify-registration": { window: 60, max: 10 },
      "/security/reauthenticate": { window: 60, max: 5 },
    },
  },

  /**
   * Request hooks. A `before` hook that returns a value short-circuits the
   * endpoint, which is the only seam in front of the organization plugin's own
   * guards — see `auth-hooks.ts` for what it intercepts and, more importantly,
   * for the conditions under which it does NOT.
   */
  hooks: {
    before: organizationTeamInvitationHooks,
    // The one membership change with no organization hook: leaving.
    after: organizationMembershipAfterHooks,
  },

  databaseHooks: {
    user: {
      create: {
        before: async (newUser, context) => {
          const email = newUser.email.toLowerCase();
          // An invited address may register during the closed beta, in the
          // inviting team's UI language (falls back to "en" for org-level
          // invitations with no team). It skips email verification only when
          // the sign-up presents the invitation's own id — the secret the
          // emailed link carries; otherwise it verifies by code like anyone.
          const invitation = await findSignupInvitation({
            email,
            invitationId:
              context?.headers?.get(SIGNUP_INVITATION_HEADER) ?? null,
          });
          if (invitation) {
            const language = invitation.teamId
              ? await getTeamLocale(invitation.teamId)
              : "en";
            return {
              data: {
                ...newUser,
                language,
                ...(invitation.ownershipProven ? { emailVerified: true } : {}),
              },
            };
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
      invitationExpiresIn: INVITATION_EXPIRY_SECONDS,
      invitationLimit: PENDING_INVITATION_LIMIT,
      cancelPendingInvitationsOnReInvite: true,
      organizationHooks: {
        afterCreateOrganization: async (data) => {
          await db.insert(schema.organizationSettings).values({
            organizationId: data.organization.id,
          });
          // Seed the one required system type (`document`) + the `mentions`
          // link type FIRST — the document-field template below resolves the
          // `document` collection and throws if it is missing.
          await seedSystemOntology(data.organization.id);
          // Seed the deletable starter ontology (company, person, note, task).
          await seedStarterCollections(data.organization.id);
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
          await onTeamCreated({
            teamId: data.team.id,
            organizationId: data.team.organizationId,
          });
          await journalAfterTheFact({
            organizationId: data.team.organizationId,
            actorUserId: data.user?.id ?? null,
            action: "team.created",
            principal: { type: "team", id: data.team.id },
            metadata: { teamName: data.team.name },
          });
        },
        // Before, not after: once deleted, nothing on an invitation says
        // which team it was for (`withdraw-for-deleted-team.ts`).
        beforeDeleteTeam: async (data) => {
          await withdrawInvitationsToDeletedTeam({
            organizationId: data.team.organizationId,
            teamId: data.team.id,
            teamName: data.team.name,
            actorUserId: data.user?.id ?? null,
          });
        },
        afterDeleteTeam: async (data) => {
          await onMembershipChanged(data.team.organizationId);
          await journalAfterTheFact({
            organizationId: data.team.organizationId,
            actorUserId: data.user?.id ?? null,
            action: "team.deleted",
            principal: { type: "team", id: data.team.id },
            metadata: { teamName: data.team.name },
          });
        },
        // Who belongs where changed: every cached principal of the
        // organization is stale (`authz/load-principal.ts`).
        afterAddMember: async (data) => {
          await onMembershipChanged(data.organization.id);
        },
        afterAddTeamMember: async (data) => {
          await onMembershipChanged(data.organization.id);
        },
        afterAcceptInvitation: async (data) => {
          await onMembershipChanged(data.organization.id);
        },
        afterRemoveMember: async (data) => {
          await onMemberLeftOrganization({
            organizationId: data.organization.id,
            userId: data.member.userId,
          });
        },
        afterRemoveTeamMember: async (data) => {
          await onMemberLeftTeam({
            organizationId: data.organization.id,
            teamId: data.team.id,
            userId: data.teamMember.userId,
          });
        },
        // A demoted admin loses admin rights on their next request: the bump
        // drops every cached principal of the organization.
        afterUpdateMemberRole: async (data) => {
          await onMembershipChanged(data.organization.id);
        },
      },

      // Only ever reached for an invitation into the organization: the
      // "existing member joins one more team" case is served by
      // `organizationTeamInvitationHooks`, which sends its own email through
      // the same service.
      sendInvitationEmail: async (data) => {
        await sendOrganizationInvitationEmail({
          invitationId: data.id,
          email: data.email,
          inviterName: data.inviter.user.name,
          organizationName: data.organization.name,
          role: data.role,
          teamId: data.invitation.teamId ?? null,
          expiresAt: data.invitation.expiresAt,
        });
      },

      teams: {
        enabled: true,
        maximumTeams: async (data) => maximumTeamsFor(data.organizationId),
        maximumMembersPerTeam: MAX_MEMBERS_PER_TEAM,
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
        // The callback only has the address, so resolve the recipient's
        // stored language by email (falls back to "en" — e.g. the new
        // address of a change-email OTP, or a not-yet-created user).
        const lang = await getUserLocaleByEmail(email);
        const { subject, html } = await generateOtpEmail(type, otp, lang);
        // Not awaited, so the response takes the same time whether or not
        // the address exists. Caught, because an unhandled rejection (the
        // mail provider down, a refused key) exits the whole process.
        sendEmail({ to: { email }, subject, html }).catch((err: unknown) => {
          console.error(
            "[auth] OTP email failed:",
            err instanceof Error ? err.message : err,
          );
        });
      },
    }),

    twoFactor({
      issuer: "Fretik",
    }),

    // Passkeys (WebAuthn): sign in with a fingerprint, face or device PIN.
    // The RP ID, the pinned origin and why user verification is enforced are
    // documented in `auth-passkey.ts`. A passkey sign-in skips two-factor,
    // like everywhere else: the passkey is itself two factors.
    passkey(passkeyOptions),

    // "Confirm it's you" + the security settings' passkey list, and the
    // audit/email side effects of adding or removing a passkey.
    accountSecurity(),

    // Desktop (Electron) support. Adds the /electron/token + OAuth-proxy
    // endpoints and the redirect-cookie hand-off used by the desktop app's
    // system-browser sign-in flow. Defaults (cookiePrefix "better-auth",
    // clientID "electron") match the frontend's electronClient/electronProxyClient.
    electron(),
  ],
} satisfies BetterAuthOptions;

// `isSuperAdmin` is a typed `user.additionalField` (see the `user` block), so
// it rides on `session.user` natively — no customSession wrapper needed.
export const auth = betterAuth(options);
