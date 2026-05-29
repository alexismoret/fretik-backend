import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { teamsManifest } from "./manifest";
import { teamsMappers } from "./mappers";
import { teamsSummaries } from "./summaries";

/**
 * Microsoft Teams provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 */
export const teamsEntry: ProviderEntry = {
  manifest: teamsManifest,
  mappers: teamsMappers,
  summaries: teamsSummaries,
};

export { teamsManifest, teamsMappers, teamsSummaries };
