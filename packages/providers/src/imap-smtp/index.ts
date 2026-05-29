import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { imapSmtpHandlers } from "./handlers";
import { imapSmtpManifest } from "./manifest";
import { imapSmtpSummaries } from "./summaries";
import { testImapSmtpCredentials } from "./test-connection";

/**
 * IMAP/SMTP provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 *
 * Transport is `custom-handler`: Nango stores credentials (private-api-basic
 * template) but the dispatcher fetches them on demand and invokes our own
 * TS handlers, which talk IMAP/SMTP directly via `imapflow` + `nodemailer`.
 */
export const imapSmtpEntry: ProviderEntry = {
  manifest: imapSmtpManifest,
  handlers: imapSmtpHandlers,
  summaries: imapSmtpSummaries,
  testCredentials: testImapSmtpCredentials,
};

export {
  imapSmtpHandlers,
  imapSmtpManifest,
  imapSmtpSummaries,
  testImapSmtpCredentials,
};
