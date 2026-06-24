import { setProviders } from "@fretik/shared/external-apps/registry";
import { exchangeEntry } from "./exchange";
import { frontEntry } from "./front";
import { imapSmtpEntry } from "./imap-smtp";
import { outlookEntry } from "./outlook";
import { plannerEntry } from "./planner";
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
  exchange: exchangeEntry,
  teams: teamsEntry,
  front: frontEntry,
  shiptify: shiptifyEntry,
  planner: plannerEntry,
});

export {
  exchangeEntry,
  frontEntry,
  imapSmtpEntry,
  outlookEntry,
  plannerEntry,
  shiptifyEntry,
  teamsEntry,
};
