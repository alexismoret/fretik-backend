import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { shiptifyDynamicOptions } from "./dynamic-options";
import { shiptifyManifest } from "./manifest";
import { shiptifyMappers } from "./mappers";
import { shiptifySummaries } from "./summaries";
import { testShiptifyCredentials } from "./test-connection";

/**
 * Shiptify provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 *
 * Transport is `http-direct`: Shiptify is not on Nango's catalog, so we
 * collect the API key + account id via our own descriptor-driven form,
 * Nango (via the `private-api-key` template) stores them encrypted, and
 * the generic http-direct executor fires `fetch()` against
 * `https://api.shiptify.com` with `Authorization: <api_key>` and
 * `X-Account-ID: <account_id>` injected per the manifest's transport
 * block.
 */
export const shiptifyEntry: ProviderEntry = {
  manifest: shiptifyManifest,
  mappers: shiptifyMappers,
  summaries: shiptifySummaries,
  testCredentials: testShiptifyCredentials,
  dynamicOptions: shiptifyDynamicOptions,
};

export {
  shiptifyDynamicOptions,
  shiptifyManifest,
  shiptifyMappers,
  shiptifySummaries,
  testShiptifyCredentials,
};
