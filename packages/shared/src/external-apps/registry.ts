import {
  type ManifestAction,
  type ProviderManifest,
  providerManifestSchema,
} from "./manifest-schema";
import type {
  ProviderMappers,
  ProviderSummaries,
  RequestMapper,
  ResponseMapper,
  SummaryMapper,
} from "./provider-types";
import { outlookManifest } from "./providers/outlook/manifest";
import { outlookMappers } from "./providers/outlook/mappers";
import { outlookSummaries } from "./providers/outlook/summaries";

/**
 * Registry of every external-app provider Fretik supports. Validates each
 * manifest at module load and exposes typed lookups for the dispatcher.
 *
 * Adding a new provider is purely additive: import its manifest + mappers
 * + summaries here, append to `providers`, ship. The dispatcher, the
 * Python SDK generator and the API routes all read from this registry.
 */

export interface ProviderEntry {
  manifest: ProviderManifest;
  mappers: ProviderMappers;
  summaries: ProviderSummaries;
}

export interface ResolvedAction {
  providerKey: string;
  action: ManifestAction;
  /** Mapper that turns args into request body/query (when declared). */
  requestMapper?: RequestMapper;
  /** Mapper that normalizes the provider response (when declared). */
  responseMapper?: ResponseMapper;
  /** Approval-card summary builder — required for `kind: "write"`. */
  summary?: SummaryMapper;
}

const providers: Record<string, ProviderEntry> = {
  outlook: {
    manifest: outlookManifest,
    mappers: outlookMappers,
    summaries: outlookSummaries,
  },
};

const actionIndex = new Map<string, ResolvedAction>();

const validateProvider = (key: string, entry: ProviderEntry): void => {
  providerManifestSchema.parse(entry.manifest);

  const typeNames = new Set(Object.keys(entry.manifest.types));
  for (const action of entry.manifest.actions) {
    // Referenced mappers exist.
    if (
      action.request !== undefined &&
      !(action.request in entry.mappers.request)
    ) {
      throw new Error(
        `Provider ${key}: action ${action.name} references missing request mapper "${action.request}"`,
      );
    }
    if (
      action.response !== undefined &&
      !(action.response in entry.mappers.response)
    ) {
      throw new Error(
        `Provider ${key}: action ${action.name} references missing response mapper "${action.response}"`,
      );
    }

    // Referenced return types exist in the manifest's `types`.
    if ("ref" in action.returns && !typeNames.has(action.returns.ref)) {
      throw new Error(
        `Provider ${key}: action ${action.name} returns unknown type "${action.returns.ref}"`,
      );
    }
    if ("list" in action.returns && !typeNames.has(action.returns.list)) {
      throw new Error(
        `Provider ${key}: action ${action.name} returns list of unknown type "${action.returns.list}"`,
      );
    }

    // Every write action MUST have a summary mapper.
    if (action.kind === "write" && entry.summaries[action.name] === undefined) {
      throw new Error(
        `Provider ${key}: write action ${action.name} has no summary mapper`,
      );
    }
  }
};

const buildIndex = (): void => {
  actionIndex.clear();
  for (const [key, entry] of Object.entries(providers)) {
    validateProvider(key, entry);
    for (const action of entry.manifest.actions) {
      const fqName = `${key}.${action.name}`;
      const resolved: ResolvedAction = {
        providerKey: key,
        action,
        requestMapper:
          action.request !== undefined
            ? entry.mappers.request[action.request]
            : undefined,
        responseMapper:
          action.response !== undefined
            ? entry.mappers.response[action.response]
            : undefined,
        summary: entry.summaries[action.name],
      };
      actionIndex.set(fqName, resolved);
    }
  }
};

// Validate + index at module load.
buildIndex();

/** Lookup by fully-qualified action name, e.g. `outlook.send_email`. */
export const getAction = (qualifiedName: string): ResolvedAction | undefined =>
  actionIndex.get(qualifiedName);

/** Provider manifest by key, or `undefined` if unknown. */
export const getProvider = (providerKey: string): ProviderEntry | undefined =>
  providers[providerKey];

/** Catalogue payload for `GET /external-apps/providers`. */
export const listProviderManifests = (): ProviderManifest[] =>
  Object.values(providers).map((p) => p.manifest);

/** All provider keys (`["outlook", ...]`). */
export const listProviderKeys = (): string[] => Object.keys(providers);
