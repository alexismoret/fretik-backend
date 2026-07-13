/**
 * Pre-connect inspection for a discovered MCP server — the "auto-detect the auth
 * mode" step that lets a non-technical user connect without picking oauth /
 * api-key / basic / none by hand.
 *
 * It (1) resolves the server's own endpoint from the registry mirror (or a raw
 * URL), preferring Streamable-HTTP over SSE, (2) SSRF-checks it, and (3)
 * best-effort classifies the auth as `none` (public), `oauth` (route to the
 * existing Nango DCR flow), or `manual` (fall back to the auth picker — likely
 * an API key, which is undetectable). It NEVER commits a connection: a wrong
 * guess only pre-selects a mode in the hub, so the cost is one radio click.
 *
 * The `@ai-sdk/mcp` client throws a lossy `Error` string on 401, so the OAuth
 * detection uses a raw `fetch` to read the HTTP status + `WWW-Authenticate`
 * (RFC 9728). `listToolsOnTarget` is not SSRF-guarded on its own (only
 * `resolveMcpTarget` is), so we assert the URL here before probing.
 */

import { getMcpServer } from "../../../lib/mcp-registry/client";
import {
  curatedIconUrl,
  findCuratedMcp,
} from "../../../lib/mcp-registry/curated";
import { pickPreferredRemote } from "../../../lib/mcp-registry/normalize";
import type { McpRegistryRemote } from "../../../lib/mcp-registry/types";
import { assertPublicHttpsUrl } from "../../../lib/net/assert-public-https-url";
import { selectOrCache } from "../../../lib/redis";
import { listToolsOnTarget } from "./client";

export type McpSuggestedAuthMode = "oauth" | "none" | "manual";

export interface McpInspectResult {
  /** True when the server exposes a reachable endpoint. */
  connectable: boolean;
  serverUrl: string | null;
  /** The remote transport of the resolved endpoint. */
  transport: "http" | "sse" | null;
  suggestedAuthMode: McpSuggestedAuthMode;
  /** The API-key header a server template declares (`manual` pre-fill), or null. */
  suggestedApiKeyHeader: string | null;
  displayName: string | null;
  description: string | null;
  iconUrl: string | null;
  /** Trust signal (official/DNS-verified namespace) — drives auto-run of reads. */
  verified: boolean;
  homepage: string | null;
  qualifiedName: string | null;
  tools: { name: string; description: string | null }[];
}

const PROBE_TIMEOUT_MS = 8_000;
const INSPECT_CACHE_TTL_SECONDS = 5 * 60;

const notConnectable = (
  partial: Partial<McpInspectResult>,
): McpInspectResult => ({
  connectable: false,
  serverUrl: null,
  transport: null,
  suggestedAuthMode: "manual",
  suggestedApiKeyHeader: null,
  displayName: null,
  description: null,
  iconUrl: null,
  verified: false,
  homepage: null,
  qualifiedName: null,
  tools: [],
  ...partial,
});

/** OAuth detection: a 401/403 with a Bearer `WWW-Authenticate`, or RFC 9728 metadata. */
const looksLikeOAuth = async (serverUrl: string): Promise<boolean> => {
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fretik", version: "1.0" },
        },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      const wa = res.headers.get("www-authenticate") ?? "";
      if (/bearer/i.test(wa) || /resource_metadata/i.test(wa)) return true;
    }
  } catch {
    // fall through to the well-known probe
  }
  try {
    const origin = new URL(serverUrl).origin;
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return true;
  } catch {
    // not OAuth-discoverable
  }
  return false;
};

/** Classify the auth mode of a validated public endpoint. */
const probeAuthMode = async (
  serverUrl: string,
  transportType: "http" | "sse",
): Promise<{
  mode: McpSuggestedAuthMode;
  tools: McpInspectResult["tools"];
}> => {
  try {
    // An unauthenticated tools/list that succeeds ⇒ the server is public.
    const tools = await listToolsOnTarget({
      url: serverUrl,
      headers: {},
      transportType,
    });
    return {
      mode: "none",
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? null,
      })),
    };
  } catch {
    // Needs auth — is it discoverable OAuth, or an (undetectable) API key?
    const mode = (await looksLikeOAuth(serverUrl)) ? "oauth" : "manual";
    return { mode, tools: [] };
  }
};

/** The first `isSecret` header template a remote declares (an API-key hint). */
const secretHeaderName = (remote: McpRegistryRemote): string | null =>
  remote.headers?.find((h) => h.isSecret === true)?.name ?? null;

const runInspect = async (input: {
  qualifiedName?: string;
  serverUrl?: string;
}): Promise<McpInspectResult> => {
  // Curated (featured) app: endpoint + auth are known — skip the probe so the
  // connection is reliable, and use the real brand logo.
  if (input.qualifiedName !== undefined) {
    const curated = findCuratedMcp(input.qualifiedName);
    if (curated !== undefined) {
      const base: Partial<McpInspectResult> = {
        displayName: curated.displayName,
        description: curated.description,
        iconUrl: curatedIconUrl(curated),
        verified: true,
        homepage: curated.homepage,
        qualifiedName: curated.qualifiedName,
      };
      try {
        await assertPublicHttpsUrl(curated.serverUrl);
      } catch {
        return notConnectable(base);
      }
      return {
        ...notConnectable(base),
        connectable: true,
        serverUrl: curated.serverUrl,
        transport: curated.transport,
        suggestedAuthMode:
          curated.auth === "oauth"
            ? "oauth"
            : curated.auth === "none"
              ? "none"
              : "manual",
      };
    }
  }

  // Resolve the endpoint + display metadata.
  let serverUrl = input.serverUrl;
  let transportType: "http" | "sse" = "http";
  let apiKeyHeader: string | null = null;
  let base: Partial<McpInspectResult> = {};

  if (input.qualifiedName !== undefined) {
    const detail = await getMcpServer(input.qualifiedName);
    if (detail === null) return notConnectable({});
    const remote = pickPreferredRemote(detail.remotes);
    serverUrl = remote?.url;
    transportType = remote?.type === "sse" ? "sse" : "http";
    apiKeyHeader = remote !== undefined ? secretHeaderName(remote) : null;
    base = {
      displayName: detail.displayName,
      description: detail.description,
      iconUrl: detail.iconUrl,
      verified: detail.verified,
      homepage: detail.homepage,
      qualifiedName: detail.qualifiedName,
    };
  }

  if (serverUrl === undefined || serverUrl === "") {
    return notConnectable(base);
  }
  try {
    await assertPublicHttpsUrl(serverUrl);
  } catch {
    return notConnectable(base);
  }

  // A server that declares a secret header template needs an API key we can't
  // probe for — route straight to the manual picker, pre-filling the header.
  if (apiKeyHeader !== null) {
    return {
      ...notConnectable(base),
      connectable: true,
      serverUrl,
      transport: transportType,
      suggestedAuthMode: "manual",
      suggestedApiKeyHeader: apiKeyHeader,
    };
  }

  const probe = await probeAuthMode(serverUrl, transportType);
  return {
    ...notConnectable(base),
    connectable: true,
    serverUrl,
    transport: transportType,
    suggestedAuthMode: probe.mode,
    tools: probe.tools,
  };
};

export const inspectMcpServer = (input: {
  qualifiedName?: string;
  serverUrl?: string;
}): Promise<McpInspectResult> =>
  selectOrCache(
    () => runInspect(input),
    `mcp:inspect:${input.qualifiedName ?? input.serverUrl ?? ""}`,
    INSPECT_CACHE_TTL_SECONDS,
  );
