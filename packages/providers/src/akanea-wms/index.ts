import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { akaneaWmsHandlers } from "./handlers";
import { akaneaWmsManifest } from "./manifest";
import { akaneaWmsSummaries } from "./summaries";
import { testAkaneaWmsCredentials } from "./test-connection";

/**
 * Akanea WMS (Xtent) provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 *
 * Transport is `custom-handler`: each Xtent install has its own host and
 * authenticates with a leased license token rather than a static key, so
 * the declarative HTTP transports cannot express it. The user supplies the
 * server URL, access id, user and password through our own form; Nango
 * (via the `private-api-basic` template) stores them encrypted; the
 * handlers in `handlers.ts` lease a token per action and release it in a
 * `finally`.
 */
export const akaneaWmsEntry: ProviderEntry = {
  manifest: akaneaWmsManifest,
  handlers: akaneaWmsHandlers,
  summaries: akaneaWmsSummaries,
  testCredentials: testAkaneaWmsCredentials,
};

export {
  akaneaWmsHandlers,
  akaneaWmsManifest,
  akaneaWmsSummaries,
  testAkaneaWmsCredentials,
};
