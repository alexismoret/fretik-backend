import { deleteKeysByPrefix } from "../../lib/redis";

/**
 * Redis keying for the anonymous public page route.
 *
 * A published page is a link that can be shared anywhere, so its endpoints
 * must survive a crowd arriving at once without turning every view into a
 * fresh aggregate query. Two short TTLs: the definition rarely changes
 * (5 min), the data is cached per VARIABLE COMBINATION (60 s) so flipping a
 * period chip stays snappy while numbers stay honest.
 *
 * Both are dropped on publish/unpublish so a revoked link goes dark at once.
 */
export const PUBLIC_PAGE_CACHE_TTL = {
  definition: 300,
  data: 60,
} as const;

const prefix = (token: string): string => `page:pub:${token}`;

export const publicPageDefinitionCacheKey = (token: string): string =>
  `${prefix(token)}:def`;

export const publicPageDataCacheKey = (
  token: string,
  requestHash: string,
): string => `${prefix(token)}:data:${requestHash}`;

/**
 * Stable rendering of a value: collection keys sorted at every depth, so `{a,b}`
 * and `{b,a}` land on the same entry. Depth matters here — a dataset query is
 * itself an object nested under its dataset id.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, entry]) => `${key}=${canonical(entry)}`);
  return `{${entries.join("&")}}`;
};

/**
 * Fingerprint of everything that changes a response.
 *
 * Every part of the request has to be in here, not just the variables: two
 * viewers on different PAGES of the same table, or on opposite sort
 * directions, ask the same URL with the same variables and must never share an
 * entry — one would be served the other's rows. `datasetIds` counts too, since
 * a targeted refetch returns a strict subset.
 *
 * `Bun.hash` is fine here — this is a cache key, never a persisted or
 * security-bearing digest.
 */
export const hashPageDataRequest = (request: {
  variables: Record<string, unknown>;
  datasetIds?: string[];
  queries?: Record<string, unknown>;
}): string => {
  const parts = [
    canonical(request.variables),
    request.datasetIds ? [...request.datasetIds].sort().join(",") : "",
    request.queries ? canonical(request.queries) : "",
  ];
  return Bun.hash(parts.join("|")).toString(36);
};

export const invalidatePublicPageCache = async (
  token: string,
): Promise<void> => {
  await deleteKeysByPrefix(`${prefix(token)}:`);
};
