import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";
import { verifySmtp, withImap } from "./client";
import { parseImapConfig, parseSmtpConfig } from "./config";

/**
 * Validate user-supplied IMAP/SMTP credentials by attempting an IMAP login
 * and an SMTP verify. Returns a granular result so the UI can tell the
 * user which side failed (most common: wrong app password vs unreachable
 * host).
 */
export const testImapSmtpCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  // Step 1 — IMAP. Reject early if config is malformed so the UI doesn't
  // mis-attribute a missing-host to "SMTP failed".
  let imapCfg: ReturnType<typeof parseImapConfig>;
  try {
    imapCfg = parseImapConfig(credentials, connection_config);
  } catch (error) {
    return {
      ok: false,
      scope: "imap",
      message:
        error instanceof Error ? error.message : "Invalid IMAP configuration",
    };
  }
  try {
    await withImap(imapCfg, async () => {
      /* connect + logout — login is enough to validate */
    });
  } catch (error) {
    return {
      ok: false,
      scope: "imap",
      message: error instanceof Error ? error.message : "IMAP login failed",
    };
  }

  // Step 2 — SMTP.
  let smtpCfg: ReturnType<typeof parseSmtpConfig>;
  try {
    smtpCfg = parseSmtpConfig(credentials, connection_config);
  } catch (error) {
    return {
      ok: false,
      scope: "smtp",
      message:
        error instanceof Error ? error.message : "Invalid SMTP configuration",
    };
  }
  try {
    await verifySmtp(smtpCfg);
  } catch (error) {
    return {
      ok: false,
      scope: "smtp",
      message: error instanceof Error ? error.message : "SMTP verify failed",
    };
  }

  return { ok: true };
};
