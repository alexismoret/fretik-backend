import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { outlookManifest } from "./manifest";
import { outlookMappers } from "./mappers";
import { outlookSummaries } from "./summaries";

/**
 * Outlook provider entry — wired into the shared registry from
 * `@fretik/providers/src/index.ts` via `setProviders({...})`.
 */
export const outlookEntry: ProviderEntry = {
  manifest: outlookManifest,
  mappers: outlookMappers,
  summaries: outlookSummaries,
};

export { outlookManifest, outlookMappers, outlookSummaries };
