import {
  asString,
  bool,
  prop,
  str,
} from "@fretik/shared/external-apps/json-access";
import type { EwsConnectionConfig, EwsVersionId } from "./client";

/**
 * Pure helpers turning Nango's untyped `{ credentials, connection_config }`
 * into the typed config the EWS client accepts.
 *
 * The user only has to provide an email + password. The email doubles as the
 * Basic-auth login (the default), the Autodiscover key, and the identity.
 * Everything else is optional and resolved automatically:
 *  - `ews_url` blank → resolved from conventional URLs / Autodiscover.
 *  - `exchange_version` "auto"/blank → detected from the server's ServerInfo.
 *  - `login_override` set → used as the login instead of the email (for AD
 *    setups where the sign-in name differs, e.g. `DOMAIN\user`).
 */

const requireString = (value: unknown, label: string): string => {
  const s = asString(value);
  if (s === undefined || s.length === 0) {
    throw new Error(`Missing required Exchange field: ${label}`);
  }
  return s;
};

const isVersionId = (value: string): value is EwsVersionId =>
  value === "Exchange2010_SP2" ||
  value === "Exchange2013" ||
  value === "Exchange2013_SP1" ||
  value === "Exchange2016";

export const parseEwsConfig = (
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): EwsConnectionConfig => {
  // `email` is the field key; Nango stores it in the Basic-Auth `username`
  // slot (via the manifest `nangoKey`) and the reader normalizes it back.
  const email = requireString(prop(credentials, "email"), "email");
  const password = requireString(prop(credentials, "password"), "password");

  const loginOverride = asString(prop(connectionConfig, "login_override"));
  const loginUsername =
    loginOverride !== undefined && loginOverride.length > 0
      ? loginOverride
      : email;

  const ewsUrlRaw = asString(prop(connectionConfig, "ews_url"));
  const ewsUrl =
    ewsUrlRaw !== undefined && ewsUrlRaw.length > 0 ? ewsUrlRaw : undefined;

  // "auto" (or blank / unknown) → leave undefined so the client detects it.
  const versionRaw = str(prop(connectionConfig, "exchange_version"), "auto");
  const exchangeVersion: EwsVersionId | undefined = isVersionId(versionRaw)
    ? versionRaw
    : undefined;

  const allowSelfSigned = bool(
    prop(connectionConfig, "allow_self_signed_cert"),
    false,
  );

  return {
    email,
    loginUsername,
    password,
    ewsUrl,
    exchangeVersion,
    allowSelfSigned,
  };
};
