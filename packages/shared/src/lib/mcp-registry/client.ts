/**
 * Official MCP Registry client — DISCOVERY ONLY. Bare `fetch` (no SDK, no API
 * key) against `registry.modelcontextprotocol.io`. Queried live and Redis-cached
 * (`selectOrCache`): the responses are public, tenant-agnostic catalog data, so
 * a shared cache is safe and keeps us a polite client. Feeds the catalog +
 * inspect flow via the `searchMcpServers` / `getMcpServer` seam.
 *
 * The registry paginates by opaque cursor with no total count, and its
 * `?search=` matches server NAMES only. We fetch one bounded page (`FETCH_LIMIT`
 * servers) per query and paginate/slice locally, which preserves the catalog's
 * page-based wire without a multi-request cursor walk.
 */

import { arr, asString, prop, str } from "../../external-apps/json-access";
import { selectOrCache } from "../redis";
import {
  CURATED_QUALIFIED_NAMES,
  CURATED_REMOTE_HOSTS,
  matchCuratedEntries,
} from "./curated";
import {
  isOfficialNamespace,
  toServerDetail,
  toServerEntry,
} from "./normalize";
import type {
  McpRegistryHeader,
  McpRegistryRemote,
  McpRegistryServer,
  McpServerDetail,
  McpServerSearchResult,
} from "./types";

const BASE_URL =
  Bun.env.MCP_REGISTRY_BASE_URL ??
  "https://registry.modelcontextprotocol.io/v0.1";
const CACHE_TTL_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 10_000;
/** Registry `limit` ceiling — one page is plenty for a discovery hub. */
const FETCH_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 24;

const parseRemote = (raw: unknown): McpRegistryRemote | undefined => {
  const type = prop(raw, "type");
  const url = asString(prop(raw, "url"));
  if (url === undefined || url === "") return undefined;
  if (type !== "streamable-http" && type !== "sse") return undefined;
  const remote: McpRegistryRemote = { type, url };
  const rawHeaders = arr(prop(raw, "headers"));
  if (rawHeaders.length > 0) {
    const headers = rawHeaders
      .map((h): McpRegistryHeader | undefined => {
        const name = asString(prop(h, "name"));
        if (name === undefined || name === "") return undefined;
        const header: McpRegistryHeader = { name };
        const description = asString(prop(h, "description"));
        if (description !== undefined) header.description = description;
        const isRequired = prop(h, "isRequired");
        if (typeof isRequired === "boolean") header.isRequired = isRequired;
        const isSecret = prop(h, "isSecret");
        if (typeof isSecret === "boolean") header.isSecret = isSecret;
        return header;
      })
      .filter((h): h is McpRegistryHeader => h !== undefined);
    if (headers.length > 0) remote.headers = headers;
  }
  return remote;
};

const parseStatus = (meta: unknown): McpRegistryServer["status"] => {
  const status = prop(meta, "status");
  if (status === "deprecated" || status === "deleted") return status;
  return "active";
};

/** Parse one `{ server, _meta }` envelope; undefined when the shape is off. */
const parseServerEnvelope = (
  envelope: unknown,
): McpRegistryServer | undefined => {
  const server = prop(envelope, "server");
  const name = asString(prop(server, "name"));
  if (name === undefined || name === "") return undefined;

  const remotes = arr(prop(server, "remotes"))
    .map(parseRemote)
    .filter((r): r is McpRegistryRemote => r !== undefined);

  const officialMeta = prop(
    prop(envelope, "_meta"),
    "io.modelcontextprotocol.registry/official",
  );

  const iconSrc = asString(prop(arr(prop(server, "icons"))[0], "src"));

  return {
    name,
    title: asString(prop(server, "title")) ?? null,
    description: str(prop(server, "description")),
    websiteUrl: asString(prop(server, "websiteUrl")) ?? null,
    iconUrl: iconSrc ?? null,
    remotes,
    status: parseStatus(officialMeta),
  };
};

const registryGet = async (pathAndQuery: string): Promise<unknown> => {
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`MCP registry GET ${pathAndQuery} failed: ${res.status}`);
  }
  return res.json();
};

/** Fetch one bounded page of active servers (optionally name-searched). */
const fetchRegistryServers = async (
  q: string | undefined,
): Promise<McpRegistryServer[]> =>
  selectOrCache(
    async () => {
      const params = new URLSearchParams({
        version: "latest",
        limit: String(FETCH_LIMIT),
      });
      if (q !== undefined && q !== "") params.set("search", q);
      const body = await registryGet(`/servers?${params.toString()}`);
      const servers = arr(prop(body, "servers"))
        .map(parseServerEnvelope)
        .filter((s): s is McpRegistryServer => s !== undefined)
        .filter((s) => s.status === "active" && s.remotes.length > 0);
      return servers;
    },
    `mcp-registry:list:${q ?? ""}`,
    CACHE_TTL_SECONDS,
  );

export interface McpServerSearchInput {
  q?: string;
  page?: number;
  pageSize?: number;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Search/browse the catalog: the curated "featured" head first, then the
 * registry long tail. Browse (no query) shows only official namespaces; an
 * explicit search also surfaces community servers, after the official ones.
 * Registry entries already covered by a curated one (same name or remote host)
 * are dropped so an app never appears twice.
 */
export const searchMcpServers = async (
  input: McpServerSearchInput,
): Promise<McpServerSearchResult> => {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = input.page ?? 1;
  const isSearch = input.q !== undefined && input.q !== "";

  const curated = matchCuratedEntries(input.q);
  const registryServers = await fetchRegistryServers(input.q);
  const tail = registryServers
    .filter((s) => !CURATED_QUALIFIED_NAMES.has(s.name))
    .filter(
      (s) => !s.remotes.some((r) => CURATED_REMOTE_HOSTS.has(hostOf(r.url))),
    )
    .filter((s) => (isSearch ? true : isOfficialNamespace(s.name)))
    .sort(
      (a, b) =>
        Number(isOfficialNamespace(b.name)) -
        Number(isOfficialNamespace(a.name)),
    )
    .map(toServerEntry);

  const merged = [...curated, ...tail];
  const start = (page - 1) * pageSize;
  return {
    entries: merged.slice(start, start + pageSize),
    pagination: {
      currentPage: page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(merged.length / pageSize)),
      totalCount: merged.length,
    },
  };
};

/** A server's detail for the inspect flow, or null when unknown to the registry. */
export const getMcpServer = async (
  qualifiedName: string,
): Promise<McpServerDetail | null> =>
  selectOrCache(
    async () => {
      const encoded = encodeURIComponent(qualifiedName);
      let body: unknown;
      try {
        body = await registryGet(`/servers/${encoded}/versions/latest`);
      } catch {
        return null;
      }
      const server = parseServerEnvelope(body);
      return server === undefined ? null : toServerDetail(server);
    },
    `mcp-registry:server:${qualifiedName}`,
    CACHE_TTL_SECONDS,
  );
