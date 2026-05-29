import { asString, num, prop } from "@fretik/shared/external-apps/json-access";
import type {
  ImapConnectionConfig,
  SecureMode,
  SmtpConnectionConfig,
} from "./client";

/**
 * Pure helpers that turn Nango's untyped `{ credentials, connection_config }`
 * into the typed configs the IMAP/SMTP clients accept. A single password
 * (stored in `credentials.password`) is shared by both protocols — the
 * v1 form does not expose a separate SMTP password (covers the vast
 * majority of mail servers: Exchange, Gmail, OVH, Fastmail, Yahoo, …).
 */

const requireString = (value: unknown, label: string): string => {
  const s = asString(value);
  if (s === undefined || s.length === 0) {
    throw new Error(`Missing required IMAP/SMTP field: ${label}`);
  }
  return s;
};

const requireSecure = (value: unknown, label: string): SecureMode => {
  const s = asString(value);
  if (s !== "tls" && s !== "starttls") {
    throw new Error(
      `Invalid value for ${label}: expected "tls" or "starttls", got ${String(s)}`,
    );
  }
  return s;
};

export const parseImapConfig = (
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): ImapConnectionConfig => {
  const username = requireString(prop(credentials, "username"), "username");
  const password = requireString(prop(credentials, "password"), "password");
  return {
    host: requireString(prop(connectionConfig, "imap_host"), "imap_host"),
    port: num(prop(connectionConfig, "imap_port"), 993),
    secure: requireSecure(prop(connectionConfig, "imap_secure"), "imap_secure"),
    username,
    password,
  };
};

export const parseSmtpConfig = (
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): SmtpConnectionConfig => {
  const username = requireString(prop(credentials, "username"), "username");
  const password = requireString(prop(credentials, "password"), "password");
  return {
    host: requireString(prop(connectionConfig, "smtp_host"), "smtp_host"),
    port: num(prop(connectionConfig, "smtp_port"), 465),
    secure: requireSecure(prop(connectionConfig, "smtp_secure"), "smtp_secure"),
    username,
    password,
  };
};
