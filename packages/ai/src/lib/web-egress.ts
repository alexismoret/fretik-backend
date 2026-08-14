import { TOOL_ERROR_CODES } from "./tool-error-codes";

/**
 * Egress hardening for the chatbot's web tools (`webFetch` / `searchWeb`).
 *
 * The web stays OPEN by default (parity with Claude/ChatGPT/Perplexity — an
 * allowlist would cripple legitimate user research). We do NOT implement URL
 * provenance (it mostly blocks URL *invention*, is launderable, and adds UX
 * friction). Instead this module provides:
 *
 *  1. Always-on hygiene (zero UX cost): reject non-http(s) schemes, internal /
 *     private / loopback / link-local / metadata targets, and over-long URLs.
 *  2. Opt-in operator levers (off by default): a denylist
 *     (`AI_WEB_BLOCKED_DOMAINS`) and a dormant allowlist
 *     (`AI_WEB_ALLOWED_DOMAINS`, which flips to deny-by-default when set).
 *     Both apply to fetch targets AND to discovered URLs (`isUrlDenied`), so
 *     search never surfaces a page the fetch path would refuse.
 *  3. A disable switch (`AI_WEB_TOOLS_ENABLED=false`) plus a missing Tavily
 *     key, either of which prunes the web tools from every registry
 *     (`pruneWebTools`) and from the chatbot's per-step tool list.
 *
 * Honesty note: Tavily fetches server-side, so SSRF-against-Fretik is already
 * near-nil. `assertFetchableTarget` matters mainly for a clean structured error
 * to the model, saving a wasted Tavily credit, and future-proofing a direct
 * fetch. The substantive operator controls are the denylist / allowlist /
 * disable. The residual exfil-via-injection risk in the open default is
 * accepted + documented (bounded to the team's own data by the C10 RLS role).
 */

/** Structured egress-validation failure. Returned to the model, never thrown at it. */
export interface WebEgressErrorDetail {
  code:
    | typeof TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET
    | typeof TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED;
  message: string;
}

export class WebEgressError extends Error {
  constructor(public readonly detail: WebEgressErrorDetail) {
    super(detail.message);
    this.name = "WebEgressError";
  }
}

/** Resolved egress policy. Pure inputs so the validator stays unit-testable. */
export interface EgressPolicy {
  blockedDomains: string[];
  allowedDomains: string[];
  maxUrlLen: number;
}

const DEFAULT_MAX_URL_LEN = 2048;

const parseDomainList = (raw: string | undefined): string[] => {
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
};

/**
 * Read the egress policy from env on each call (cheap). Operators set the env
 * and restart; tests call the `*WithPolicy` variants with explicit lists.
 */
export const currentEgressPolicy = (): EgressPolicy => {
  const rawLen = Number(process.env.AI_WEB_FETCH_MAX_URL_LEN);
  return {
    blockedDomains: parseDomainList(process.env.AI_WEB_BLOCKED_DOMAINS),
    allowedDomains: parseDomainList(process.env.AI_WEB_ALLOWED_DOMAINS),
    maxUrlLen:
      Number.isFinite(rawLen) && rawLen > 0 ? rawLen : DEFAULT_MAX_URL_LEN,
  };
};

/** Operator disable switch for both web tools. Read by the agent tool wiring. */
export const areWebToolsEnabled = (): boolean =>
  process.env.AI_WEB_TOOLS_ENABLED !== "false";

/**
 * Lowercased, punycode-normalized host of a URL (IPv6 brackets stripped), or
 * `null` if the URL doesn't parse. `new URL().hostname` already lowercases and
 * IDN→punycode-encodes, so visually-confusable homographs (`аmazon.com` with a
 * Cyrillic `а`) normalize to their `xn--…` form — denylist/allowlist match the
 * real domain, not the lookalike.
 */
export const hostFromUrl = (url: string): string | null => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
};

/**
 * Wildcard host matcher. `*.example.com` matches only subdomains; a bare
 * `example.com` matches the apex AND its subdomains (denylist/allowlist
 * semantics: blocking/allowing a domain covers its subdomains).
 */
const hostMatches = (host: string, pattern: string): boolean => {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern || host.endsWith(`.${pattern}`);
};

const isPrivateIpv4 = (host: string): boolean => {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (incl. 100.100.100.200)
  return false;
};

const isPrivateIpv6 = (host: string): boolean => {
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  // IPv4-mapped (`::ffff:…`) — the URL parser may emit either the dotted or the
  // compressed hex form (`::ffff:7f00:1`); both are an SSRF-evasion shape and
  // never a legitimate public fetch target, so block the whole prefix.
  if (host.startsWith("::ffff:")) return true;
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return false;
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local (incl. fd00:ec2::254)
  return false;
};

/**
 * Internal hostnames that should never be a public-web fetch target: the
 * loopback alias, common internal TLDs, and any single-label host (no public
 * domain has a dotless hostname).
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

const fail = (code: WebEgressErrorDetail["code"], message: string): never => {
  throw new WebEgressError({ code, message });
};

/**
 * Validate that `rawUrl` is a safe public-web fetch target under `policy`.
 * Throws `WebEgressError` on any violation; callers catch it and return a
 * structured `{ error, code }` to the model (tools never throw at the model).
 */
export const assertFetchableTargetWithPolicy = (
  rawUrl: string,
  policy: EgressPolicy,
): void => {
  if (rawUrl.length > policy.maxUrlLen) {
    fail(
      TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
      `URL exceeds the ${policy.maxUrlLen}-character limit`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebEgressError({
      code: TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
      message: "Invalid URL",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(
      TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
      `Scheme "${parsed.protocol}" is not allowed; use http or https`,
    );
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (isInternalHostname(host) || isPrivateIpv4(host) || isPrivateIpv6(host)) {
    fail(
      TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
      `"${host}" is an internal or private address and cannot be fetched`,
    );
  }

  if (policy.blockedDomains.some((p) => hostMatches(host, p))) {
    fail(
      TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED,
      `Domain "${host}" is blocked by this deployment's policy`,
    );
  }

  if (
    policy.allowedDomains.length > 0 &&
    !policy.allowedDomains.some((p) => hostMatches(host, p))
  ) {
    fail(
      TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED,
      `Domain "${host}" is not in this deployment's allowlist`,
    );
  }
};

/** `assertFetchableTargetWithPolicy` against the live env policy. */
export const assertFetchableTarget = (rawUrl: string): void =>
  assertFetchableTargetWithPolicy(rawUrl, currentEgressPolicy());

/**
 * True when a discovered URL (a `searchWeb` hit, a `webMap` result) should be
 * dropped before the model ever sees it. Applies the SAME domain policy as
 * `assertFetchableTarget`: the denylist always, and — when an allowlist is
 * configured — anything outside it. Surfacing a URL the fetch path would
 * refuse wastes a credit and pushes the model to cite a page it cannot read.
 */
export const isUrlDenied = (
  url: string,
  policy: EgressPolicy = currentEgressPolicy(),
): boolean => {
  if (
    policy.blockedDomains.length === 0 &&
    policy.allowedDomains.length === 0
  ) {
    return false;
  }
  const host = hostFromUrl(url);
  if (host === null) return false;
  if (policy.blockedDomains.some((p) => hostMatches(host, p))) return true;
  return (
    policy.allowedDomains.length > 0 &&
    !policy.allowedDomains.some((p) => hostMatches(host, p))
  );
};

/**
 * The web tools gated by `AI_WEB_TOOLS_ENABLED` and by the presence of a
 * Tavily key. Canonical list — the chatbot's `prepareStep` suppression and
 * the registry pruning below both read it, so a new web tool is gated in one
 * place.
 */
export const WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  "searchWeb",
  "webFetch",
  "webMap",
]);

/**
 * True when the web tools should exist at all on this deployment: the
 * operator switch is on AND a Tavily key is configured (every web tool is
 * Tavily-backed; without a key they can only fail).
 */
export const areWebToolsAvailable = (): boolean =>
  areWebToolsEnabled() && Boolean(process.env.TAVILY_API_KEY);

/**
 * Return the registry unchanged when the web tools are available (the normal
 * case), and strip them ONLY when the operator disabled them or no Tavily key
 * is set. Applied to the registries built once at boot (sub-agents, workflow
 * runs), which install no `prepareStep`; the chatbot instead filters per step,
 * which also strips the tools from the prompt's catalogue.
 */
export const pruneWebToolsIfUnavailable = <T extends Record<string, unknown>>(
  registry: T,
): T => {
  if (areWebToolsAvailable()) return registry;
  const pruned = { ...registry };
  for (const name of WEB_TOOL_NAMES) delete pruned[name];
  return pruned;
};
