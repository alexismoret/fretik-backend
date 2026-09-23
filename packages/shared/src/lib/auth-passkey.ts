import {
  getAuthenticatorName,
  type PasskeyOptions,
} from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";

import db from "../db";
import { passkey } from "../db/schema";
import { isAppleDevice } from "./user-agent";

/**
 * Passkey (WebAuthn) configuration for the Better Auth `passkey` plugin.
 *
 * Two decisions here are load-bearing and easy to get wrong:
 *
 * 1. **The RP ID is the frontend's domain, not the API's.** The plugin falls
 *    back to the hostname of `BETTER_AUTH_URL`, which in production is the API
 *    (`api.fretik.com`), while the ceremony runs in the browser on the app's
 *    origin. WebAuthn requires the RP ID to be that origin's host or one of
 *    its registrable parents, so the fallback would fail every ceremony. It
 *    defaults to the host of `APP_URL`; `PASSKEY_RP_ID` may widen it to a
 *    parent domain (e.g. `fretik.com`) so passkeys survive a move between
 *    subdomains. Choose it once: changing it orphans every registered passkey.
 *
 * 2. **A passkey sign-in skips the password AND the second factor**, like on
 *    every major service. That is only sound if the passkey itself is two
 *    factors: something you have (the device) plus something you are or know
 *    (biometrics or the device PIN). WebAuthn calls the second part "user
 *    verification" and the plugin does not require it, so both ceremonies
 *    below refuse a credential the authenticator did not verify its user for.
 */

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw new Error("Missing APP_URL env");
}

const appOrigin = new URL(appUrl).origin;
const appHostname = new URL(appUrl).hostname;

export const PASSKEY_RP_ID = (() => {
  const configured = process.env.PASSKEY_RP_ID?.trim().toLowerCase();
  if (!configured) return appHostname;
  // A mismatch would not fail at boot but on every single ceremony, in the
  // browser, with an opaque SecurityError. Fail loudly here instead.
  if (appHostname !== configured && !appHostname.endsWith(`.${configured}`)) {
    throw new Error(
      `PASSKEY_RP_ID "${configured}" must be the app's hostname "${appHostname}" or one of its parent domains`,
    );
  }
  return configured;
})();

/** Error codes Fretik adds on top of `PASSKEY_ERROR_CODES`. */
export const PASSKEY_USER_VERIFICATION_REQUIRED =
  "PASSKEY_USER_VERIFICATION_REQUIRED";

const userVerificationRequired = () =>
  new APIError("BAD_REQUEST", {
    code: PASSKEY_USER_VERIFICATION_REQUIRED,
    message:
      "This passkey did not verify your identity (fingerprint, face or device PIN). Use a passkey that does.",
  });

const ANONYMOUS_AAGUID = "00000000-0000-0000-0000-000000000000";

/**
 * Authenticators the plugin's built-in list (`commonAuthenticatorNames`) does
 * not know. Names mirror passkeydeveloper/passkey-authenticator-aaguids.
 */
const EXTRA_AUTHENTICATOR_NAMES: Record<string, string> = {
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
};

/**
 * Best-effort provider name for an authenticator model (AAGUID), e.g.
 * "Google Password Manager" or "1Password". `null` for unknown models and for
 * the all-zero AAGUID privacy-preserving platforms report.
 */
export const resolvePasskeyProvider = (
  aaguid: string | null | undefined,
): string | null => {
  const normalized = aaguid?.trim().toLowerCase();
  if (!normalized || normalized === ANONYMOUS_AAGUID) return null;
  return (
    getAuthenticatorName(normalized) ??
    EXTRA_AUTHENTICATOR_NAMES[normalized] ??
    null
  );
};

/**
 * The label a new passkey gets when the user did not name it (they never do:
 * the enrolment is one click). The AAGUID names most providers; Apple hides
 * it (all zeros under `attestation: "none"`), so a platform passkey created on
 * an Apple device is recognised by the `internal` transport plus the user
 * agent. Anything else stays unnamed and the UI renders a localized default.
 */
export const defaultPasskeyName = (params: {
  aaguid: string | null | undefined;
  transports: readonly string[] | undefined;
  userAgent: string | null | undefined;
}): string | undefined => {
  const provider = resolvePasskeyProvider(params.aaguid);
  if (provider) return provider;
  const isPlatform = params.transports?.includes("internal") ?? false;
  if (isPlatform && isAppleDevice(params.userAgent)) {
    return "iCloud Keychain";
  }
  return undefined;
};

export const passkeyOptions = {
  rpID: PASSKEY_RP_ID,
  rpName: "Fretik",
  // Pin the expected origin instead of trusting the request's `Origin`
  // header: only the web app may run a ceremony for this RP.
  origin: appOrigin,
  authenticatorSelection: {
    // A discoverable credential is what makes a passkey a passkey: the
    // authenticator stores the account, so the user signs in without typing
    // an email and the browser can offer it from the email field's autofill.
    residentKey: "required",
    // Ask the authenticator to verify its user at creation; enforced below.
    userVerification: "required",
  },
  registration: {
    afterVerification: async ({ ctx, verification, clientData }) => {
      if (!verification.registrationInfo?.userVerified) {
        throw userVerificationRequired();
      }
      return {
        name: defaultPasskeyName({
          aaguid: verification.registrationInfo.aaguid,
          transports: clientData.response.transports,
          userAgent: ctx.headers?.get("user-agent"),
        }),
      };
    },
  },
  authentication: {
    afterVerification: async ({ verification, clientData }) => {
      if (!verification.authenticationInfo.userVerified) {
        throw userVerificationRequired();
      }
      // Not a Better Auth field (see the `passkey` table): the security
      // settings list shows it. Best effort — never blocks a sign-in.
      try {
        await db
          .update(passkey)
          .set({ lastUsedAt: new Date() })
          .where(eq(passkey.credentialID, clientData.id));
      } catch (err) {
        console.warn("[passkey] failed to stamp lastUsedAt:", err);
      }
    },
  },
} satisfies PasskeyOptions;
