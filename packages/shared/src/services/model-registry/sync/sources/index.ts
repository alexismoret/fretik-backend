import type { CatalogueSource } from "../../../../model-registry/catalogue";
import type { TransportId } from "../../../../model-registry/types";
import {
  GATEWAY_CATALOGUE_CAPABILITIES,
  fetchGatewayCatalog,
} from "./gateway-catalog";
import { fetchGatewayEndpoints } from "./gateway-endpoints";
import {
  OPENROUTER_CATALOGUE_CAPABILITIES,
  fetchOpenRouterCatalog,
} from "./openrouter-catalog";
import { fetchOpenRouterEndpoints } from "./openrouter-endpoints";
import { fetchOpenRouterZdrRoutes } from "./openrouter-zdr";
import { createScalewaySource } from "./scaleway-catalog";

/**
 * OpenRouter, with its zero-retention list fetched once and shared.
 *
 * The list covers the entire catalogue in one call, and every endpoint read
 * needs it to tell a zero-retention route from a route we simply have not
 * checked. Fetching it per model would multiply one request by the size of the
 * fleet; hoisting it into the pass is what the closure is for.
 */
const createOpenRouterSource = (): CatalogueSource => {
  let routes: Promise<Set<string> | undefined> | undefined;
  return {
    id: "openrouter",
    capabilities: OPENROUTER_CATALOGUE_CAPABILITIES,
    listModels: fetchOpenRouterCatalog,
    fetchEndpoints: async (modelId) => {
      routes ??= fetchOpenRouterZdrRoutes();
      return fetchOpenRouterEndpoints(modelId, await routes);
    },
  };
};

/**
 * The catalogue sources, one per transport, built fresh for each sync pass.
 *
 * This registry is what replaced the sync's hard-wired knowledge of who serves
 * what. Before it, discovery read the gateway catalogue and only the gateway
 * catalogue, and endpoints were fetched by an `if (transport === "gateway") …
 * else if (transport === "openrouter") … else throw` — so a third transport was
 * not a new entry anywhere, it was an edit to every site that had enumerated
 * the first two.
 *
 * Per PASS, not per process, because two of the three sources hold state for
 * the duration of a run: OpenRouter prefetches its zero-retention route list
 * once instead of once per model, and Scaleway holds a three-fetch snapshot.
 * A registry cached across passes would serve tonight's sync yesterday's
 * catalogue, which is the one bug a nightly job must not have.
 *
 * Order is deliberate and it is the only place it matters. The merge lets a
 * source that DECLARES a fact overrule one that infers it, so ordering cannot
 * decide modalities or owners; sizes take the smallest across sources and
 * cannot depend on it either. What order does decide is which id a model that
 * several transports serve is first recorded under — so the aggregators come
 * first, and Scaleway, which serves 15 models against their several hundred,
 * comes last.
 */
export const createCatalogueSources = (): CatalogueSource[] => [
  {
    id: "gateway",
    capabilities: GATEWAY_CATALOGUE_CAPABILITIES,
    listModels: fetchGatewayCatalog,
    fetchEndpoints: fetchGatewayEndpoints,
  },
  createOpenRouterSource(),
  createScalewaySource(),
];

/**
 * The source serving a transport, or `undefined` when none does.
 *
 * `undefined` is a real answer rather than an error: `TRANSPORT_IDS` declares
 * `custom` for team-supplied endpoints, which has no catalogue by definition —
 * a base URL its owner typed in is not something we can enumerate.
 */
export const sourceForTransport = (
  sources: readonly CatalogueSource[],
  transport: TransportId,
): CatalogueSource | undefined =>
  sources.find((source) => source.id === transport);
