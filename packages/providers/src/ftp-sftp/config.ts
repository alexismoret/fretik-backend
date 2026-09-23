import { asString, prop } from "@fretik/shared/external-apps/json-access";
import type { FileTransferConfig, FileTransferProtocol } from "./client";

/**
 * Pure helpers turning Nango's untyped `{ credentials, connection_config }`
 * into the typed config the file-transfer client accepts.
 *
 * Two things this file exists to absorb.
 *
 * **Everything arrives as a string.** The frontend coerces every
 * `connection_config` value with `String(v)` before handing it to Nango
 * (Nango's `params` are `Record<string, string>`), so a number field comes
 * back `"2222"` and a boolean toggle comes back `"true"`. Reading those with
 * the shared `num()` / `bool()` helpers would silently take the fallback —
 * a self-signed-certificate toggle that never turns on, a port that resets
 * to 22. Hence `readPort` / `readBoolean` below.
 *
 * **The port is optional by design.** Asking every user for a port number
 * they do not know is how a connection form loses people; the standard port
 * is a function of the protocol, and only a non-standard one is worth
 * typing.
 */

const DEFAULT_PORTS: Record<FileTransferProtocol, number> = {
  sftp: 22,
  ftp: 21,
  ftps: 21,
  "ftps-implicit": 990,
};

const requireString = (value: unknown, label: string): string => {
  const s = asString(value)?.trim();
  if (s === undefined || s.length === 0) {
    throw new Error(`Missing required field: ${label}`);
  }
  return s;
};

const optionalString = (value: unknown): string | undefined => {
  const s = asString(value);
  return s !== undefined && s.trim().length > 0 ? s : undefined;
};

const isProtocol = (value: string): value is FileTransferProtocol =>
  value === "sftp" ||
  value === "ftp" ||
  value === "ftps" ||
  value === "ftps-implicit";

/** Accepts a real number, a numeric string, or nothing. */
const readPort = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const s = asString(value)?.trim();
  if (s === undefined || s.length === 0) return fallback;
  const parsed = Number.parseInt(s, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
};

/** Accepts a real boolean or the string Nango stored it as. */
const readBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  const s = asString(value)?.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
};

export const parseFileTransferConfig = (
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): FileTransferConfig => {
  const protocolRaw = requireString(
    prop(connectionConfig, "protocol"),
    "protocol",
  );
  if (!isProtocol(protocolRaw)) {
    throw new Error(
      `Unsupported protocol "${protocolRaw}". Expected sftp, ftp, ftps or ftps-implicit.`,
    );
  }
  const protocol: FileTransferProtocol = protocolRaw;

  const authMethod =
    asString(prop(connectionConfig, "auth_method")) ?? "password";
  const password = optionalString(prop(credentials, "password"));
  const privateKey = optionalString(prop(credentials, "private_key"));

  if (authMethod === "private_key" && protocol !== "sftp") {
    throw new Error(
      "FTP and FTPS authenticate with a password only. SSH key authentication is only available on SFTP. Switch the protocol to SFTP, or set a password.",
    );
  }
  if (authMethod === "private_key" && privateKey === undefined) {
    throw new Error(
      "Authentication is set to SSH key but no private key was provided.",
    );
  }
  if (authMethod !== "private_key" && password === undefined) {
    throw new Error("Missing required field: password.");
  }

  return {
    protocol,
    host: requireString(prop(connectionConfig, "host"), "host"),
    port: readPort(prop(connectionConfig, "port"), DEFAULT_PORTS[protocol]),
    username: requireString(prop(credentials, "username"), "username"),
    // Only ever send the secret the chosen method needs. Handing `ssh2`
    // both a key and a password makes it try them in its own order, so a
    // stale password left in the form could decide an auth the user
    // believes is key-based — and the failure then names the wrong thing.
    ...(authMethod === "private_key"
      ? {
          privateKey,
          ...(optionalString(prop(credentials, "passphrase")) !== undefined
            ? { passphrase: optionalString(prop(credentials, "passphrase")) }
            : {}),
        }
      : { password }),
    ...(optionalString(prop(connectionConfig, "host_fingerprint")) !== undefined
      ? {
          hostFingerprint: optionalString(
            prop(connectionConfig, "host_fingerprint"),
          ),
        }
      : {}),
    allowSelfSignedCert: readBoolean(
      prop(connectionConfig, "allow_self_signed_cert"),
    ),
    rootPath: optionalString(prop(connectionConfig, "root_path")) ?? "",
  };
};
