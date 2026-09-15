import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { ftpSftpHandlers } from "./handlers";
import { ftpSftpManifest } from "./manifest";
import { ftpSftpSummaries } from "./summaries";
import { testFtpSftpCredentials } from "./test-connection";

/**
 * FTP/SFTP provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 *
 * Transport is `custom-handler`: neither protocol is HTTP, so Nango stores
 * the credentials (private-api-bearer template, one encrypted JSON envelope
 * — see SETUP.md) and the dispatcher fetches them on demand to invoke our
 * own handlers, which talk SFTP via `ssh2-sftp-client` and FTP/FTPS via
 * `basic-ftp`.
 */
export const ftpSftpEntry: ProviderEntry = {
  manifest: ftpSftpManifest,
  handlers: ftpSftpHandlers,
  summaries: ftpSftpSummaries,
  testCredentials: testFtpSftpCredentials,
};

export {
  ftpSftpHandlers,
  ftpSftpManifest,
  ftpSftpSummaries,
  testFtpSftpCredentials,
};
