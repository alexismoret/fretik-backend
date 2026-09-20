import { setProviders } from "@fretik/shared/external-apps/registry";
import { akaneaWmsEntry } from "./akanea-wms";
import { evalFixtureEntry } from "./eval-fixture";
import { exchangeEntry } from "./exchange";
import { frontEntry } from "./front";
import { ftpSftpEntry } from "./ftp-sftp";
import { imapSmtpEntry } from "./imap-smtp";
import { outlookEntry } from "./outlook";
import { pbypEntry } from "./pbyp";
import { plannerEntry } from "./planner";
import { sharepointEntry } from "./sharepoint";
import { shiptifyEntry } from "./shiptify";
import { teamsEntry } from "./teams";

/**
 * Bootstrap registration of every external-app provider Fretik supports.
 *
 * Imported once at application boot:
 *   import "@fretik/providers";
 *
 * by `@fretik/api/src/index.ts` and `@fretik/ai/src/index.ts`. This module's
 * top-level call to `setProviders(...)` populates the shared registry and
 * rebuilds the action index. All downstream lookups (dispatcher, OpenAPI
 * catalogue, gen:sdk) go through the registry — they never import a
 * provider directly.
 */
setProviders({
  outlook: outlookEntry,
  "imap-smtp": imapSmtpEntry,
  "ftp-sftp": ftpSftpEntry,
  exchange: exchangeEntry,
  teams: teamsEntry,
  front: frontEntry,
  shiptify: shiptifyEntry,
  planner: plannerEntry,
  sharepoint: sharepointEntry,
  "akanea-wms": akaneaWmsEntry,
  pbyp: pbypEntry,
  // A test double, registered unconditionally rather than behind an env flag:
  // `gen:sdk` enumerates the registry and CI diffs its output, so a provider
  // that appears only under a flag would have its generated SDK + SKILL deleted
  // by every run that did not set it. `manifest.testOnly` is what keeps it out
  // of the connect catalogue and out of the credential fetch.
  "eval-fixture": evalFixtureEntry,
});

export {
  akaneaWmsEntry,
  evalFixtureEntry,
  exchangeEntry,
  frontEntry,
  ftpSftpEntry,
  imapSmtpEntry,
  outlookEntry,
  pbypEntry,
  plannerEntry,
  sharepointEntry,
  shiptifyEntry,
  teamsEntry,
};
