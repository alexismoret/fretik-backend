/**
 * Registry-server normalization. Maps the raw registry JSON (parsed defensively
 * in `client.ts`) to the catalog + inspect shapes, classifies "official"
 * (DNS-verified namespace) for the badge, and picks which advertised remote we
 * connect to. No host is filtered out — a discovered server is connected direct
 * to whatever endpoint it advertises, through our own transport.
 */

import { faviconUrlForServer } from "../../services/external-apps/mcp/favicon";
import type {
  McpRegistryRemote,
  McpRegistryServer,
  McpServerDetail,
  McpServerEntry,
} from "./types";

/** GitHub-namespaced servers published BY the org that owns them count as
 * official despite the `io.github.*` prefix. Keep this set tiny. */
const OFFICIAL_GITHUB_NAMESPACE_ALLOWLIST = new Set(["io.github.github"]);

/** The namespace part of a registry name (`com.notion/mcp` -> `com.notion`). */
const namespaceOf = (name: string): string => {
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(0, slash);
};

/**
 * A server is "official" when its namespace was DNS-verified at publish time
 * (any non-`io.github.*` reverse-DNS domain), or it's an allow-listed vendor
 * GitHub org. Community `io.github.*` servers are not official.
 */
export const isOfficialNamespace = (name: string): boolean => {
  const ns = namespaceOf(name);
  if (OFFICIAL_GITHUB_NAMESPACE_ALLOWLIST.has(ns)) return true;
  return !ns.startsWith("io.github.");
};

/** Prefer streamable-http (our default transport), else the first remote. */
export const pickPreferredRemote = (
  remotes: McpRegistryRemote[],
): McpRegistryRemote | undefined =>
  remotes.find((r) => r.type === "streamable-http") ?? remotes[0];

/** Logo: the registry icon, else a favicon derived from the site or endpoint. */
const iconFor = (server: McpRegistryServer): string | null => {
  if (server.iconUrl !== null) return server.iconUrl;
  const fallbackTarget =
    server.websiteUrl ?? pickPreferredRemote(server.remotes)?.url;
  return fallbackTarget !== undefined
    ? faviconUrlForServer(fallbackTarget)
    : null;
};

export const toServerEntry = (server: McpRegistryServer): McpServerEntry => ({
  qualifiedName: server.name,
  displayName: server.title ?? server.name,
  description: server.description,
  iconUrl: iconFor(server),
  homepage: server.websiteUrl,
  verified: isOfficialNamespace(server.name),
});

export const toServerDetail = (server: McpRegistryServer): McpServerDetail => ({
  qualifiedName: server.name,
  displayName: server.title ?? server.name,
  description: server.description,
  iconUrl: iconFor(server),
  homepage: server.websiteUrl,
  verified: isOfficialNamespace(server.name),
  remotes: server.remotes,
});
