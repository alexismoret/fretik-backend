import { ALL_TRAFFIC } from "e2b";

/**
 * Egress allowlist for E2B sandboxes. Default policy is deny-all
 * (`denyOut: [ALL_TRAFFIC]`); only domains/IPs/CIDRs listed in
 * `allowOut` are reachable. Wildcards like `*.fretik.com` cover every
 * subdomain in one entry.
 *
 * Storage: hardcoded TS const for v1. Adding a domain requires code
 * review + release. Migration to a DB-backed list is possible later if
 * we need an admin UI to manage it without redeploying.
 */

export const SANDBOX_ALLOWED_DOMAINS = {
  /**
   * Fretik infrastructure — sandbox can call back into our own
   * API/SaaS. Useful for skills that enrich data through internal
   * endpoints (use only with short-lived tokens).
   */
  fretik: ["*.fretik.com", "fretik.com"],

  /**
   * Python package manager. Allows runtime `pip install` from the
   * sandbox when a future skill needs a library not pre-baked in the
   * template.
   */
  pypi: ["pypi.org", "*.pythonhosted.org"],

  /**
   * Node package manager. Same rationale and same risk profile as
   * `pypi` above — the sandbox already executes agent-authored code, so
   * a registry adds no capability, only a supply-chain surface we
   * accept symmetrically for both ecosystems. Load-bearing: the bundled
   * Office skills create decks and documents with Node libraries
   * (`pptxgenjs`, `docx`), and without this entry every `npm install`
   * they prescribe dies on a silent TLS timeout. The common ones are
   * pre-baked in the template so the happy path needs no network at
   * all; this covers what a skill or a user asks for beyond them.
   */
  npm: ["registry.npmjs.org", "*.npmjs.org"],

  /**
   * Source repos. `git clone` / raw fetches for analysis scripts or
   * skills pointing at public references.
   */
  vcs: ["*.github.com", "github.com", "*.githubusercontent.com"],

  /**
   * Common B2B SaaS APIs the sandbox may legitimately need to call —
   * collaboration, CRM, payments, analytics, project management.
   * Starter list, extend as integrations land. Wildcards cover the
   * full vendor domain so we don't miss subdomains (e.g. `api.*`,
   * `*.googleapis.com`).
   */
  b2b: [
    // Google Workspace (Drive, Gmail, Calendar, Sheets, …)
    "*.googleapis.com",
    "*.google.com",
    // Microsoft 365 / Graph
    "graph.microsoft.com",
    "*.microsoft.com",
    "*.office.com",
    // Collaboration
    "slack.com",
    "*.slack.com",
    "api.notion.com",
    "api.airtable.com",
    // CRM
    "*.salesforce.com",
    "api.hubapi.com",
    // Payments / billing
    "api.stripe.com",
    // Project / issue tracking
    "api.linear.app",
    "*.atlassian.com",
    "*.atlassian.net",
    // Customer support
    "*.zendesk.com",
    "*.intercom.io",
  ],
} as const;

export interface SandboxNetworkPolicy {
  allowOut: string[];
  denyOut: string[];
}

export interface NetworkPolicyOverrides {
  /** Extra domains/IPs added on top of the default allowlist. */
  extraAllowOut?: string[];
}

/**
 * Extract the host portion of `FRETIK_BACKEND_INTERNAL_URL` so the
 * sandbox is allowed to call our backend's `/sandbox/exec` endpoint.
 *
 * In prod the URL is `https://api.fretik.com` (already covered by the
 * `*.fretik.com` wildcard), so this resolves to a redundant entry and
 * does nothing observable. In local dev `dev.sh` provisions a tunnl.gg
 * forwarding and injects a URL like `https://abc-123.tunnl.gg` — that
 * host is NOT on the static allowlist, and the E2B network policy
 * silently kills the TLS handshake (the user sees
 * `SSLEOFError: UNEXPECTED_EOF_WHILE_READING` in their Python kernel).
 *
 * We allow the entire `*.tunnl.gg` wildcard rather than the specific
 * subdomain because tunnl.gg rotates the subdomain on every SSH
 * reconnect, and we want a fresh `dev.sh` run to "just work" without
 * having to recycle every active sandbox to refresh its policy.
 *
 * Returns `[]` when the env var is missing/unparseable/localhost so
 * the caller skips the entry entirely.
 */
const detectBackendHostsForAllowlist = (): string[] => {
  const raw = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
  if (raw === undefined || raw === "") return [];
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return [];
  }
  if (host === "" || host === "localhost") return [];
  if (host.endsWith(".tunnl.gg")) return ["*.tunnl.gg"];
  return [host];
};

/**
 * Compose the network policy passed to `Sandbox.create`. Default deny
 * via `ALL_TRAFFIC` + the curated allowlist + optional per-call extras
 * (used by future workflow nodes that scope egress to a specific
 * third-party API). Also auto-adds the host of
 * `FRETIK_BACKEND_INTERNAL_URL` so the sandbox can reach
 * `/sandbox/exec` regardless of where the backend is deployed.
 */
export const buildSandboxNetworkPolicy = (
  overrides?: NetworkPolicyOverrides,
): SandboxNetworkPolicy => ({
  allowOut: [
    ...SANDBOX_ALLOWED_DOMAINS.fretik,
    ...SANDBOX_ALLOWED_DOMAINS.pypi,
    ...SANDBOX_ALLOWED_DOMAINS.npm,
    ...SANDBOX_ALLOWED_DOMAINS.vcs,
    ...SANDBOX_ALLOWED_DOMAINS.b2b,
    ...detectBackendHostsForAllowlist(),
    ...(overrides?.extraAllowOut ?? []),
  ],
  denyOut: [ALL_TRAFFIC],
});
