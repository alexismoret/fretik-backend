import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";
import { withSession } from "./client";
import { parseFileTransferConfig } from "./config";
import { resolveRemotePath } from "./paths";

/**
 * Validate user-supplied FTP/SFTP credentials by connecting AND listing the
 * folder the connection will actually work in.
 *
 * Logging in is not the test. An account can authenticate and still land
 * nowhere useful — a `root_path` typo, a chroot that does not contain the
 * folder, a key whose account has no read permission — and every one of
 * those failures otherwise shows up later as an empty folder the agent
 * reports as "there are no files", which is indistinguishable from the
 * truth. One `LIST` at connect time turns all of them into a message the
 * user can act on while the form is still open.
 *
 * `scope` splits the two things a user has to fix differently: `config` is a
 * value they typed wrong (unknown protocol, missing password), `connection`
 * is the server refusing them.
 */
export const testFtpSftpCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  let config: ReturnType<typeof parseFileTransferConfig>;
  try {
    config = parseFileTransferConfig(credentials, connection_config);
  } catch (error) {
    return {
      ok: false,
      scope: "config",
      message:
        error instanceof Error ? error.message : "Invalid connection settings",
    };
  }

  try {
    await withSession(config, async (session) => {
      const start =
        config.rootPath === ""
          ? (await session.describe()).workingDirectory
          : resolveRemotePath(config.rootPath, "");
      await session.list(start);
    });
  } catch (error) {
    return {
      ok: false,
      scope: "connection",
      message: describeFailure(error, config.rootPath),
    };
  }

  return { ok: true };
};

/**
 * Turn the two stacks' raw errors into something a person can act on.
 *
 * These messages are read by someone staring at a connection form, not at a
 * stack trace: `All configured authentication methods failed` and `530` are
 * both accurate and both useless, and the actual fix (an app password, the
 * wrong protocol, a self-signed certificate) is exactly what they omit.
 */
const describeFailure = (error: unknown, rootPath: string): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  // The hint follows as its own sentence, so the raw message loses any
  // trailing full stop rather than doubling it.
  const lead = raw.replace(/[.\s]+$/, "");

  if (
    lower.includes("all configured authentication methods failed") ||
    lower.includes("530") ||
    lower.includes("permission denied")
  ) {
    return `${lead}. Check the username and password, or the private key and its passphrase.`;
  }
  if (lower.includes("host key") || lower.includes("hostverifier")) {
    return `${lead}. The server's host key does not match the fingerprint pinned on this connection.`;
  }
  if (
    lower.includes("self signed") ||
    lower.includes("self-signed") ||
    lower.includes("unable to verify the first certificate")
  ) {
    return `${lead}. Turn on "Allow self-signed certificate" in the advanced settings if this server uses its own certificate authority.`;
  }
  if (lower.includes("econnrefused")) {
    return `${lead}. Nothing is listening on that host and port. SFTP is usually 22, FTP and FTPS 21, implicit FTPS 990.`;
  }
  if (lower.includes("etimedout") || lower.includes("timed out")) {
    return `${lead}. The server did not answer. Check the host, the port, and whether it allows connections from outside your network.`;
  }
  if (lower.includes("550") || lower.includes("no such file")) {
    return rootPath === ""
      ? `${lead}. The account signed in, but its starting folder could not be listed.`
      : `${lead}. The account signed in, but the root folder "${rootPath}" could not be listed. Check the path, or leave it empty.`;
  }
  return raw;
};
