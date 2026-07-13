/**
 * SSRF guard for user-supplied MCP server URLs.
 *
 * Unlike the manifest/Nango-proxy paths (Nango fetches upstream, so an SSRF
 * against Fretik is near-nil), the direct MCP transport fetches a URL the user
 * typed straight from our own runtime. This asserts the URL is a well-formed,
 * public, https target before we connect — at connect time (confirm) AND on
 * every dispatch (a stored row's URL could have been tampered with).
 *
 * The lexical host predicates mirror `@fretik/ai`'s `web-egress.ts`. The
 * duplication is deliberate: `@fretik/shared` cannot import `@fretik/ai`, and
 * the two policies differ (web-egress is open-web + operator denylist and
 * allows http; this is https-only, no lists, and additionally resolves DNS).
 *
 * DNS is resolved so a public hostname that points at a private address is
 * rejected. The residual DNS-rebinding TOCTOU (the transport's `fetch`
 * re-resolves after this check) is accepted for v1; the transport's
 * `redirect: "error"` default closes the redirect-to-internal vector.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** One resolved DNS address — the subset the guard inspects. */
export interface ResolvedAddress {
  address: string;
}

export interface UrlGuardOptions {
  /**
   * DNS resolver, injectable for tests. Defaults to `Bun.dns.lookup(host,
   * { family: "any" })`, returning every A/AAAA record.
   */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /**
   * Dev escape hatch: allow http + private/loopback targets (e.g. a local MCP
   * server on `http://localhost:8931/mcp`). Defaults to the
   * `MCP_ALLOW_PRIVATE_URLS=true` env flag.
   */
  allowPrivate?: boolean;
}

const MAX_URL_LEN = 2048;

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const isPrivateIpv4 = (host: string): boolean => {
  const m = host.match(IPV4_LITERAL);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (![a, b, c, d].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return false;
  }
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
};

const isPrivateIpv6 = (host: string): boolean => {
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  // IPv4-mapped (`::ffff:…`) — dotted or compressed hex form; both are an
  // SSRF-evasion shape, never a legitimate public target.
  if (host.startsWith("::ffff:")) return true;
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return false;
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
  return false;
};

/**
 * Internal hostnames that must never be a public target: the loopback alias,
 * common internal TLDs, and any single-label host (no public domain has a
 * dotless hostname).
 */
const isInternalHostname = (host: string): boolean => {
  if (host === "localhost") return true;
  if (
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  return !host.includes(".") && !host.includes(":");
};

const isPrivateAddress = (host: string): boolean =>
  isInternalHostname(host) || isPrivateIpv4(host) || isPrivateIpv6(host);

const defaultResolve = async (hostname: string): Promise<ResolvedAddress[]> => {
  const records = await Bun.dns.lookup(hostname, { family: "any" });
  return records.map((r) => ({ address: r.address }));
};

/**
 * Throw `UnsafeUrlError` unless `rawUrl` is a well-formed public https URL
 * whose hostname does NOT resolve to a private/loopback/link-local address.
 */
export const assertPublicHttpsUrl = async (
  rawUrl: string,
  opts?: UrlGuardOptions,
): Promise<void> => {
  const allowPrivate =
    opts?.allowPrivate ?? Bun.env.MCP_ALLOW_PRIVATE_URLS === "true";

  if (rawUrl.length > MAX_URL_LEN) {
    throw new UnsafeUrlError(
      `MCP server URL exceeds the ${MAX_URL_LEN.toString()}-character limit`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("MCP server URL is not a valid URL");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new UnsafeUrlError(
      "MCP server URL must not embed credentials (user:password@…)",
    );
  }

  const httpsOnly = parsed.protocol === "https:";
  const httpAllowed = allowPrivate && parsed.protocol === "http:";
  if (!httpsOnly && !httpAllowed) {
    throw new UnsafeUrlError(
      `MCP server URL scheme "${parsed.protocol}" is not allowed; use https`,
    );
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (allowPrivate) return; // dev: skip the private-address checks entirely

  if (isPrivateAddress(host)) {
    throw new UnsafeUrlError(
      `"${host}" is an internal or private address and cannot be reached`,
    );
  }

  // Literal IPs are fully judged by the lexical checks above (a private one
  // already threw; a public one is fine) — only real hostnames need DNS.
  const isIpLiteral = IPV4_LITERAL.test(host) || host.includes(":");
  if (isIpLiteral) return;

  const resolve = opts?.resolve ?? defaultResolve;
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnsafeUrlError(`Could not resolve MCP server host "${host}"`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(
      `MCP server host "${host}" resolved to no address`,
    );
  }
  for (const { address } of addresses) {
    if (isPrivateIpv4(address) || isPrivateIpv6(address.toLowerCase())) {
      throw new UnsafeUrlError(
        `MCP server host "${host}" resolves to a private address and cannot be reached`,
      );
    }
  }
};
