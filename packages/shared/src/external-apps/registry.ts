import {
  type ManifestAction,
  type ProviderManifest,
  providerManifestSchema,
} from "./manifest-schema";
import type {
  ProviderDynamicOptions,
  ProviderHandler,
  ProviderHandlers,
  ProviderMappers,
  ProviderSummaries,
  ProviderTestCredentials,
  RequestMapper,
  ResponseMapper,
  SummaryMapper,
} from "./provider-types";

/**
 * Registry of every external-app provider Fretik supports. Validates each
 * manifest at registration and exposes typed lookups for the dispatcher,
 * the OpenAPI catalogue endpoint and the Python SDK generator.
 *
 * Providers themselves live in the `@fretik/providers` package — this
 * registry only holds the contract + the indexed store. The application
 * entrypoint (`@fretik/api`, `@fretik/ai`) does `import "@fretik/providers";`
 * once at boot, which triggers a `setProviders({...})` call that registers
 * every provider and rebuilds the action index. This inversion keeps
 * `@fretik/shared` free of provider-specific code and heavy deps
 * (imapflow, nodemailer, etc.).
 */

export interface ProviderEntry {
  manifest: ProviderManifest;
  /**
   * Optional request/response transformers, keyed by mapper name. Allowed
   * for `nango-proxy` (required there) and `http-direct` (optional —
   * `buildRequest` covers most cases generically).
   */
  mappers?: ProviderMappers;
  /** Required when manifest.transport.kind === "custom-handler". */
  handlers?: ProviderHandlers;
  /** Required when manifest.credentialsForm?.testConnection.supported. */
  testCredentials?: ProviderTestCredentials;
  /**
   * Resolvers for `dynamic-select` credential fields, keyed by
   * `optionsHandler` name. Required when the credentialsForm declares
   * at least one such field; the registry validates every reference.
   */
  dynamicOptions?: ProviderDynamicOptions;
  /** Required when any action has kind === "write". */
  summaries: ProviderSummaries;
}

export interface ResolvedAction {
  providerKey: string;
  /**
   * Full provider manifest the action belongs to. Carried for executors
   * that need descriptor-level info (e.g. http-direct's reverse
   * `nangoKey` normalization reads `credentialsForm.fields`).
   */
  manifest: ProviderManifest;
  transport: ProviderManifest["transport"];
  action: ManifestAction;
  /** Mapper that turns args into request body/query (nango-proxy only). */
  requestMapper?: RequestMapper;
  /** Mapper that normalizes the provider response (nango-proxy only). */
  responseMapper?: ResponseMapper;
  /** Custom handler for the action (custom-handler only). */
  handler?: ProviderHandler;
  /** Approval-card summary builder — required for `kind: "write"`. */
  summary?: SummaryMapper;
}

const providers: Record<string, ProviderEntry> = {};
const actionIndex = new Map<string, ResolvedAction>();

const validateProvider = (key: string, entry: ProviderEntry): void => {
  providerManifestSchema.parse(entry.manifest);

  const transport = entry.manifest.transport;
  const typeNames = new Set(Object.keys(entry.manifest.types));

  // Transport-specific module requirements.
  if (transport.kind === "nango-proxy") {
    if (entry.mappers === undefined) {
      throw new Error(
        `Provider ${key}: nango-proxy transport requires a "mappers" module`,
      );
    }
    if (entry.handlers !== undefined) {
      throw new Error(
        `Provider ${key}: nango-proxy transport must NOT register handlers`,
      );
    }
  } else if (transport.kind === "http-direct") {
    // Mappers are optional for http-direct — `buildRequest` handles the
    // generic param-placement path. Handlers are forbidden: the egress is
    // the generic `fetch()` executor, not arbitrary TS code.
    if (entry.handlers !== undefined) {
      throw new Error(
        `Provider ${key}: http-direct transport must NOT register handlers`,
      );
    }
  } else {
    if (entry.handlers === undefined) {
      throw new Error(
        `Provider ${key}: custom-handler transport requires a "handlers" module`,
      );
    }
    if (entry.mappers !== undefined) {
      throw new Error(
        `Provider ${key}: custom-handler transport must NOT register mappers`,
      );
    }
  }

  // testCredentials required when the credentialsForm exposes a Test button.
  if (
    entry.manifest.credentialsForm?.testConnection.supported === true &&
    entry.testCredentials === undefined
  ) {
    throw new Error(
      `Provider ${key}: credentialsForm.testConnection.supported is true but no "testCredentials" function is exposed`,
    );
  }

  // Every `dynamic-select` field MUST resolve to a registered handler.
  if (entry.manifest.credentialsForm !== undefined) {
    for (const field of entry.manifest.credentialsForm.fields) {
      if (field.kind !== "dynamic-select") continue;
      const handlerName = field.optionsHandler;
      if (handlerName === undefined) continue; // schema already rejected
      if (
        entry.dynamicOptions === undefined ||
        !(handlerName in entry.dynamicOptions)
      ) {
        throw new Error(
          `Provider ${key}: dynamic-select field "${field.key}" references missing options handler "${handlerName}"`,
        );
      }
    }
  }

  for (const action of entry.manifest.actions) {
    if (transport.kind === "nango-proxy" || transport.kind === "http-direct") {
      const mappers = entry.mappers;
      if (mappers !== undefined) {
        if (
          action.request !== undefined &&
          !(action.request in mappers.request)
        ) {
          throw new Error(
            `Provider ${key}: action ${action.name} references missing request mapper "${action.request}"`,
          );
        }
        if (
          action.response !== undefined &&
          !(action.response in mappers.response)
        ) {
          throw new Error(
            `Provider ${key}: action ${action.name} references missing response mapper "${action.response}"`,
          );
        }
      } else if (
        action.request !== undefined ||
        action.response !== undefined
      ) {
        throw new Error(
          `Provider ${key}: action ${action.name} references mappers but no "mappers" module is registered`,
        );
      }
    } else {
      const handlers = entry.handlers;
      if (handlers === undefined) continue;
      // Action's `handler` field is enforced as required at schema level
      // when transport is custom-handler; here we just check it resolves.
      if (action.handler === undefined || !(action.handler in handlers)) {
        throw new Error(
          `Provider ${key}: action ${action.name} references missing handler "${String(action.handler)}"`,
        );
      }
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
    if ("page" in action.returns && !typeNames.has(action.returns.page)) {
      throw new Error(
        `Provider ${key}: action ${action.name} returns page of unknown type "${action.returns.page}"`,
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
        manifest: entry.manifest,
        transport: entry.manifest.transport,
        action,
        requestMapper:
          entry.mappers !== undefined && action.request !== undefined
            ? entry.mappers.request[action.request]
            : undefined,
        responseMapper:
          entry.mappers !== undefined && action.response !== undefined
            ? entry.mappers.response[action.response]
            : undefined,
        handler:
          entry.handlers !== undefined && action.handler !== undefined
            ? entry.handlers[action.handler]
            : undefined,
        summary: entry.summaries[action.name],
      };
      actionIndex.set(fqName, resolved);
    }
  }
};

/**
 * Register one or more providers. Called at app boot from
 * `@fretik/providers/src/index.ts` (which is imported once by the
 * application entrypoint). Replaces any existing entries with the same
 * key and rebuilds the action index.
 */
export const setProviders = (
  newProviders: Record<string, ProviderEntry>,
): void => {
  for (const [key, entry] of Object.entries(newProviders)) {
    providers[key] = entry;
  }
  buildIndex();
};

/** Lookup by fully-qualified action name, e.g. `outlook.send_email`. */
export const getAction = (qualifiedName: string): ResolvedAction | undefined =>
  actionIndex.get(qualifiedName);

/** Provider entry by key, or `undefined` if unknown. */
export const getProvider = (providerKey: string): ProviderEntry | undefined =>
  providers[providerKey];

/** Catalogue payload for `GET /external-apps/providers`. */
export const listProviderManifests = (): ProviderManifest[] =>
  Object.values(providers).map((p) => p.manifest);

/** All provider keys (`["outlook", "imap-smtp", ...]`). */
export const listProviderKeys = (): string[] => Object.keys(providers);
