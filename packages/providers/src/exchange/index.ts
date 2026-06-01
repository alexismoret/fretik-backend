import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { exchangeHandlers } from "./handlers";
import { exchangeManifest } from "./manifest";
import { exchangeSummaries } from "./summaries";
import { testExchangeCredentials } from "./test-connection";

/**
 * Microsoft Exchange (self-hosted EWS) provider entry — wired into the
 * shared registry from `@fretik/providers/src/index.ts`.
 *
 * Transport is `custom-handler`: Nango stores Basic-auth credentials
 * (private-api-basic template) but the dispatcher fetches them on demand and
 * invokes our handlers, which talk EWS (SOAP) directly via
 * `ews-javascript-api` (HTTP Basic over TLS).
 */
export const exchangeEntry: ProviderEntry = {
  manifest: exchangeManifest,
  handlers: exchangeHandlers,
  summaries: exchangeSummaries,
  testCredentials: testExchangeCredentials,
};

export {
  exchangeHandlers,
  exchangeManifest,
  exchangeSummaries,
  testExchangeCredentials,
};
