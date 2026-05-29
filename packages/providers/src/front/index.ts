import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { frontManifest } from "./manifest";
import { frontMappers } from "./mappers";
import { frontSummaries } from "./summaries";

/**
 * Front provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 */
export const frontEntry: ProviderEntry = {
  manifest: frontManifest,
  mappers: frontMappers,
  summaries: frontSummaries,
};

export { frontManifest, frontMappers, frontSummaries };
