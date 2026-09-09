import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { pbypDynamicOptions } from "./dynamic-options";
import { pbypManifest } from "./manifest";
import { pbypMappers } from "./mappers";
import { pbypOnConnected } from "./on-connected";
import { pbypSummaries } from "./summaries";
import { testPbypCredentials } from "./test-connection";

/**
 * Pbyp provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 *
 * Transport is `http-direct`: Pbyp runs on Directus and is not on Nango's
 * catalog, so the user pastes a personal API key (Pbyp → Profile
 * management → API key) and picks a profile, Nango stores both through the
 * `private-api-bearer` template, and the generic executor calls the
 * Directus REST API with `Authorization: Bearer <key>`.
 *
 * `onConnected` then activates the chosen profile on Pbyp — without it the
 * connection would answer under whatever profile the account last used.
 */
export const pbypEntry: ProviderEntry = {
  manifest: pbypManifest,
  mappers: pbypMappers,
  summaries: pbypSummaries,
  testCredentials: testPbypCredentials,
  dynamicOptions: pbypDynamicOptions,
  onConnected: pbypOnConnected,
};

export {
  pbypDynamicOptions,
  pbypManifest,
  pbypMappers,
  pbypOnConnected,
  pbypSummaries,
  testPbypCredentials,
};
