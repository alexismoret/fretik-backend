import type { ProviderEntry } from "@fretik/shared/external-apps/registry";
import { evalFixtureHandlers } from "./handlers";
import { evalFixtureManifest } from "./manifest";

/**
 * Eval fixture provider entry — registered like any other, and hidden from the
 * connect catalogue by `manifest.testOnly`.
 *
 * `summaries` is empty because every action is a read; the registry only
 * demands a summary mapper for `kind: "write"`, and this provider writes
 * nothing by design — a test double that could change state would be a test
 * double that needs cleaning up between cases.
 */
export const evalFixtureEntry: ProviderEntry = {
  manifest: evalFixtureManifest,
  handlers: evalFixtureHandlers,
  summaries: {},
};

export { evalFixtureHandlers, evalFixtureManifest };
