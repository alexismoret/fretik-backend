import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { plannerManifest } from "./manifest";
import { plannerMappers } from "./mappers";
import { plannerSummaries } from "./summaries";

/**
 * Microsoft Planner provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 */
export const plannerEntry: ProviderEntry = {
  manifest: plannerManifest,
  mappers: plannerMappers,
  summaries: plannerSummaries,
};

export { plannerManifest, plannerMappers, plannerSummaries };
