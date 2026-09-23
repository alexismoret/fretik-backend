import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { symmetricDecrypt } from "better-auth/crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import db from "../db";
import { passkey } from "../db/schema";
import { sendSecurityNotice } from "../services/auth/send-security-notice";
import { recordAuthEvent } from "./auth-audit";
import { resolvePasskeyProvider } from "./auth-passkey";

/**
 * Account security endpoints Better Auth does not ship, mounted under
 * `/auth/security/*`, plus the audit + email side effects of passkey changes.
 *
 * - `POST /security/reauthenticate` — "confirm it's you". Some endpoints
 *   (adding a passkey, among others) demand a FRESH session: one created less
 *   than `session.freshAge` ago. Signing in again would be the only way to get
 *   one, and it is a poor one inside the app: the sign-in creates a session
 *   with no active organization or team, and with two-factor enabled it even
 *   drops the current session cookie before redirecting to `/2fa`. This
 *   endpoint checks the password (and the TOTP code when two-factor is on),
 *   then rotates the session the way Better Auth's own two-factor enrolment
 *   does: a new session carrying the old one's fields (active organization and
 *   team), cookie swapped, old session deleted. The new session is fresh.
 *
 * - `GET /security/passkeys` — the current user's passkeys, shaped for the
 *   security settings: resolved provider name and last use (the plugin's own
 *   list knows neither), without the public key nobody displays.
 */

export const ACCOUNT_SECURITY_ERROR_CODES = {
  TWO_FACTOR_CODE_REQUIRED: "TWO_FACTOR_CODE_REQUIRED",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  INVALID_TWO_FACTOR_CODE: "INVALID_TWO_FACTOR_CODE",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "CREDENTIAL_ACCOUNT_NOT_FOUND",
} as const;

const reauthenticateBody = z.object({
  password: z.string().min(1),
  // Required only when two-factor is enabled; the first call without it
  // answers TWO_FACTOR_CODE_REQUIRED so the UI can ask for it.
  code: z.string().trim().optional(),
});

/**
 * Session columns that describe the session itself; everything else (active
 * organization, active team, ...) is carried over to the rotated session.
 */
const OWN_SESSION_FIELDS = new Set([
  "id",
  "token",
  "userId",
  "expiresAt",
  "createdAt",
  "updatedAt",
  "ipAddress",
  "userAgent",
]);

const verifyTotp = async (
  secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"],
  userId: string,
  code: string,
): Promise<boolean> => {
  const row = await db.query.twoFactor.findFirst({
    columns: { secret: true, lockedUntil: true },
    where: { userId },
  });
  if (!row) return false;
  // The two-factor plugin's lockout (too many failed sign-in challenges)
  // applies here too: a locked account is locked everywhere.
  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    throw new APIError("TOO_MANY_REQUESTS", {
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      message: "Too many failed attempts. Try again later.",
    });
  }
  const secret = await symmetricDecrypt({
    key: secretConfig,
    data: row.secret,
  });
  // Same period and digits as the two-factor plugin's defaults, which
  // `lib/auth.ts` does not override.
  return createOTP(secret, { period: 30, digits: 6 }).verify(code);
};

const reauthenticate = createAuthEndpoint(
  "/security/reauthenticate",
  {
    method: "POST",
    body: reauthenticateBody,
    use: [sessionMiddleware],
  },
  async (ctx) => {
    const { session, user } = ctx.context.session;
    const auditDetails = {
      ip: session.ipAddress,
      userAgent: ctx.headers?.get("user-agent") ?? session.userAgent,
    };

    const account = await ctx.context.internalAdapter.findCredentialAccount(
      user.id,
    );
    if (!account?.password) {
      throw new APIError("BAD_REQUEST", {
        code: ACCOUNT_SECURITY_ERROR_CODES.CREDENTIAL_ACCOUNT_NOT_FOUND,
        message: "This account has no password.",
      });
    }
    const passwordOk = await ctx.context.password.verify({
      hash: account.password,
      password: ctx.body.password,
    });
    if (!passwordOk) {
      await recordAuthEvent(
        "auth.reauthenticate_failed",
        user.id,
        auditDetails,
      );
      throw new APIError("BAD_REQUEST", {
        code: ACCOUNT_SECURITY_ERROR_CODES.INVALID_PASSWORD,
        message: "Invalid password.",
      });
    }

    // Read from the table, not the session: the session's user may be a
    // cached copy from before two-factor was switched on.
    const twoFactorEnabled =
      (
        await db.query.user.findFirst({
          columns: { twoFactorEnabled: true },
          where: { id: user.id },
        })
      )?.twoFactorEnabled ?? false;
    if (twoFactorEnabled) {
      if (!ctx.body.code) {
        throw new APIError("FORBIDDEN", {
          code: ACCOUNT_SECURITY_ERROR_CODES.TWO_FACTOR_CODE_REQUIRED,
          message: "Enter the code from your authenticator app.",
        });
      }
      const codeOk = await verifyTotp(
        ctx.context.secretConfig,
        user.id,
        ctx.body.code,
      );
      if (!codeOk) {
        await recordAuthEvent("auth.reauthenticate_failed", user.id, {
          ...auditDetails,
          metadata: { factor: "totp" },
        });
        throw new APIError("BAD_REQUEST", {
          code: ACCOUNT_SECURITY_ERROR_CODES.INVALID_TWO_FACTOR_CODE,
          message: "Invalid code.",
        });
      }
    }

    // Rotate: keep the workspace context, renew everything that makes the
    // session "fresh". Honour the "don't remember me" choice of the original
    // sign-in, as the two-factor plugin does when it creates a session.
    const carried = Object.fromEntries(
      Object.entries(session).filter(([key]) => !OWN_SESSION_FIELDS.has(key)),
    );
    const dontRememberMe = Boolean(
      await ctx.getSignedCookie(
        ctx.context.authCookies.dontRememberToken.name,
        ctx.context.secret,
      ),
    );
    const rotated = await ctx.context.internalAdapter.createSession(
      user.id,
      dontRememberMe,
      carried,
    );
    if (!rotated) {
      throw new APIError("INTERNAL_SERVER_ERROR", {
        code: "FAILED_TO_CREATE_SESSION",
        message: "Failed to create session.",
      });
    }
    await setSessionCookie(ctx, { session: rotated, user }, dontRememberMe);
    await ctx.context.internalAdapter.deleteSession(session.token);
    await recordAuthEvent("auth.reauthenticated", user.id, auditDetails);

    return ctx.json({ status: true });
  },
);

const listPasskeys = createAuthEndpoint(
  "/security/passkeys",
  {
    method: "GET",
    use: [sessionMiddleware],
  },
  async (ctx) => {
    const rows = await db
      .select({
        id: passkey.id,
        name: passkey.name,
        aaguid: passkey.aaguid,
        credentialID: passkey.credentialID,
        deviceType: passkey.deviceType,
        backedUp: passkey.backedUp,
        transports: passkey.transports,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
      })
      .from(passkey)
      .where(eq(passkey.userId, ctx.context.session.user.id))
      .orderBy(asc(passkey.createdAt));

    return ctx.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        provider: resolvePasskeyProvider(row.aaguid),
        // The browser's Signal API needs it to forget a deleted passkey.
        credentialId: row.credentialID,
        deviceType: row.deviceType,
        backedUp: row.backedUp,
        transports: row.transports
          ? row.transports.split(",").filter(Boolean)
          : [],
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
      })),
    );
  },
);

// --- Passkey change side effects ------------------------------------------

/**
 * Name of a passkey about to be deleted, read in the `before` hook and
 * consumed by the `after` hook (the row is gone by then). Keyed by
 * `userId:passkeyId`, always cleared by the `after` hook.
 */
const pendingDeletions = new Map<string, string | null>();

const pendingDeletionKey = (userId: string, passkeyId: string) =>
  `${userId}:${passkeyId}`;

const passkeyIdBody = z.object({ id: z.string().min(1) });

const passkeyIdFromBody = (body: unknown): string | null =>
  passkeyIdBody.safeParse(body).data?.id ?? null;

/** The passkey row `/passkey/verify-registration` answers with. */
const registeredPasskey = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().nullish(),
});

const isFailure = (returned: unknown) =>
  returned instanceof APIError || returned instanceof Error;

export const accountSecurity = () =>
  ({
    id: "account-security",
    endpoints: {
      reauthenticate,
      listSecurityPasskeys: listPasskeys,
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const passkeyId = passkeyIdFromBody(ctx.body);
            const session = await getSessionFromCtx(ctx);
            if (!passkeyId || !session) return;
            const row = await db.query.passkey.findFirst({
              columns: { name: true },
              where: { id: passkeyId, userId: session.user.id },
            });
            if (!row) return;
            // Bounded: every request that lands here is cleared by the
            // matching `after` hook; this only guards against a pathological
            // pile-up if one ever threw before clearing.
            if (pendingDeletions.size > 1000) pendingDeletions.clear();
            pendingDeletions.set(
              pendingDeletionKey(session.user.id, passkeyId),
              row.name,
            );
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!returned || isFailure(returned)) return;
            const created = registeredPasskey.safeParse(returned).data;
            if (!created) return;
            const userAgent = ctx.headers?.get("user-agent");
            await recordAuthEvent("auth.passkey_added", created.userId, {
              userAgent,
              metadata: { passkeyId: created.id, name: created.name ?? null },
            });
            void sendSecurityNotice({
              userId: created.userId,
              kind: "passkeyAdded",
              passkeyName: created.name ?? null,
              userAgent,
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const passkeyId = passkeyIdFromBody(ctx.body);
            const session = await getSessionFromCtx(ctx);
            if (!passkeyId || !session) return;
            const key = pendingDeletionKey(session.user.id, passkeyId);
            const found = pendingDeletions.has(key);
            const name = pendingDeletions.get(key) ?? null;
            pendingDeletions.delete(key);
            if (!found || isFailure(ctx.context.returned)) return;

            const userAgent = ctx.headers?.get("user-agent");
            await recordAuthEvent("auth.passkey_removed", session.user.id, {
              userAgent,
              metadata: { passkeyId, name },
            });
            void sendSecurityNotice({
              userId: session.user.id,
              kind: "passkeyRemoved",
              passkeyName: name,
              userAgent,
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/passkey/update-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const passkeyId = passkeyIdFromBody(ctx.body);
            const session = await getSessionFromCtx(ctx);
            if (!passkeyId || !session || isFailure(ctx.context.returned)) {
              return;
            }
            await recordAuthEvent("auth.passkey_renamed", session.user.id, {
              userAgent: ctx.headers?.get("user-agent"),
              metadata: { passkeyId },
            });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
