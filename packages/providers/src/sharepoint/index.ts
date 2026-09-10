import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { sharepointManifest } from "./manifest";
import { sharepointMappers } from "./mappers";
import { sharepointSummaries } from "./summaries";

/**
 * Microsoft SharePoint provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 */
export const sharepointEntry: ProviderEntry = {
  manifest: sharepointManifest,
  mappers: sharepointMappers,
  summaries: sharepointSummaries,
};

export { sharepointManifest, sharepointMappers, sharepointSummaries };
