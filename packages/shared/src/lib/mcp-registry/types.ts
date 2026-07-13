/**
 * Fretik-facing shapes for the Official MCP Registry
 * (`registry.modelcontextprotocol.io`). DISCOVERY ONLY: we read public,
 * tenant-agnostic server metadata to populate the catalog. No user or business
 * data ever transits the registry — a connection is made through the server's
 * OWN first-party endpoint (`remotes[].url`) by our existing direct transport
 * (Nango + `@ai-sdk/mcp`). See `normalize.ts` for the raw-JSON → these mappers.
 */

/** A header template a server declares (e.g. an API key the client supplies). */
export interface McpRegistryHeader {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
}

/** One remote endpoint a server advertises. `sse` needs the SSE transport. */
export interface McpRegistryRemote {
  type: "streamable-http" | "sse";
  url: string;
  headers?: McpRegistryHeader[];
}

/** A registry server, narrowed to the fields the catalog + inspect flow need. */
export interface McpRegistryServer {
  /** Reverse-DNS/name id, e.g. `com.notion/mcp` — the stable catalog key. */
  name: string;
  title: string | null;
  description: string;
  websiteUrl: string | null;
  iconUrl: string | null;
  remotes: McpRegistryRemote[];
  status: "active" | "deprecated" | "deleted";
}

export interface McpCatalogPagination {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

/** One catalog entry — what `GET /external-apps/mcp-catalog` returns per app. */
export interface McpServerEntry {
  /** Registry name; the id the connect flow inspects. */
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  homepage: string | null;
  /** DNS-verified (official) namespace — drives the badge + auto-run trust. */
  verified: boolean;
}

export interface McpServerSearchResult {
  entries: McpServerEntry[];
  pagination: McpCatalogPagination;
}

/** A server's detail, used to resolve its endpoint + transport before connect. */
export interface McpServerDetail {
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  homepage: string | null;
  verified: boolean;
  remotes: McpRegistryRemote[];
}
