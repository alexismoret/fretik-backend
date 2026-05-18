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
   * Source repos. `git clone` / raw fetches for analysis scripts or
   * skills pointing at public references.
   */
  vcs: ["*.github.com", "github.com", "*.githubusercontent.com"],

  /**
   * Transport / logistics APIs. Starter list — extend as integrations
   * land. Wildcards cover the full carrier domain so we don't miss
   * tracking subdomains.
   */
  transport: [
    // International
    "*.dhl.com",
    "*.fedex.com",
    "*.ups.com",
    // France
    "*.laposte.fr",
    "*.colissimo.fr",
    // Pan-Europe
    "*.dpd.com",
    "*.gls-group.eu",
    // Tracking aggregators
    "*.aftership.com",
    "*.trackingmore.com",
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
 * Compose the network policy passed to `Sandbox.create`. Default deny
 * via `ALL_TRAFFIC` + the curated allowlist + optional per-call extras
 * (used by future workflow nodes that scope egress to a specific
 * third-party API).
 */
export const buildSandboxNetworkPolicy = (
  overrides?: NetworkPolicyOverrides,
): SandboxNetworkPolicy => ({
  allowOut: [
    ...SANDBOX_ALLOWED_DOMAINS.fretik,
    ...SANDBOX_ALLOWED_DOMAINS.pypi,
    ...SANDBOX_ALLOWED_DOMAINS.vcs,
    ...SANDBOX_ALLOWED_DOMAINS.transport,
    ...(overrides?.extraAllowOut ?? []),
  ],
  denyOut: [ALL_TRAFFIC],
});
