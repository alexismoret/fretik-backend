import { ALL_TRAFFIC, type SandboxNetworkRules } from "e2b";
import {
  DEFAULT_ORGANIZATION_SANDBOX_POLICY,
  type OrganizationSandboxPolicy,
} from "../../schemas/sandbox-policy";

/**
 * Egress policy for the code sandbox. Default is deny-all
 * (`denyOut: [ALL_TRAFFIC]`); only what `allowOut` names is reachable.
 *
 * The policy is composed from TIERS rather than one list, because the four
 * sources answer to different owners and change at different times: our own
 * backend host comes from the deployment, provider hosts from the team's live
 * connections, the registries from this file, and the extra domains from an
 * org admin. Composition is a pure function so every combination is testable
 * without a sandbox; see `services/e2b/apply-egress.ts` for where it is
 * applied, which is EVERY code-running turn and not only at creation.
 *
 * Two things measured on a real sandbox shape the lists below (2026-09-17,
 * `scripts/smoke-sandbox-egress.ts`):
 *
 *  - E2B matches domains by SNI, and a wildcard over a shared platform hands
 *    the sandbox every tenant on it. So the entries here are exact hosts, and
 *    the previous `*.github.com` / `*.npmjs.org` / 18-domain `b2b` block —
 *    which measured ZERO outbound requests in three months while offering
 *    gists, Slack webhooks and Google Forms as ready exfiltration channels —
 *    is gone.
 *  - A blocked host does not refuse the connection: the firewall accepts the
 *    TCP handshake and then kills the TLS one, so the agent sees
 *    `UNEXPECTED_EOF_WHILE_READING` and nothing that names a policy. That is
 *    what `services/e2b/egress-hint.ts` exists to translate.
 */

export const SANDBOX_EGRESS_TIERS = {
  /**
   * Public package registries. `pip install` / `npm install` / `apt-get
   * install` are the one legitimate reason agent code reaches the internet
   * directly, and the bundled Office skills prescribe installs the happy path
   * would otherwise fail on.
   *
   * Every host is exact. `api.github.com` is deliberately ABSENT: nothing
   * installs through it, and it is where a compromised turn would POST a gist.
   */
  packages: [
    // Python
    "pypi.org",
    "files.pythonhosted.org",
    // Node
    "registry.npmjs.org",
    // Git-sourced dependencies and raw references. `codeload` serves tarballs,
    // `objects.` serves release assets that `github.com` redirects to.
    "github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    // Debian. Read off the running template, not assumed: its apt sources are
    // trixie on `deb.debian.org` for BOTH main and security
    // (`deb.debian.org/debian-security`), so `security.debian.org` would be a
    // dead entry. NodeSource is the Node 20 repo the E2B base image adds —
    // without it every `apt-get update` pays a TLS timeout and prints a
    // fetch warning the agent then tries to debug.
    "deb.debian.org",
    "deb.nodesource.com",
  ],
} as const;

export interface SandboxNetworkPolicy {
  allowOut: string[];
  denyOut: string[];
  /** Present only when a credential is brokered by the egress proxy. */
  rules?: SandboxNetworkRules;
}

export interface SandboxNetworkPolicyInput {
  /** Host of `FRETIK_BACKEND_INTERNAL_URL`, or `null` when unset/local. */
  backendHost: string | null;
  /** The org's admin-managed policy; defaults when it has never been set. */
  orgPolicy?: OrganizationSandboxPolicy;
  /** Hosts the team's ACTIVE external-app connections stream bytes from. */
  providerHosts?: readonly string[];
  /**
   * This turn's sandbox JWT. When present (and a backend host exists), the
   * policy carries a `transform` rule that makes E2B's egress proxy add
   * `Authorization: Bearer <jwt>` to requests leaving for our backend — so the
   * credential never exists inside the VM. Omit it and nothing is brokered.
   */
  brokeredJwt?: string;
}

/**
 * Host of the backend the sandbox SDK calls back into.
 *
 * Exact, including a dev tunnel's rotating subdomain. The previous version
 * allowed the whole `*.tunnl.gg` wildcard so a fresh `dev.sh` would work
 * without recycling live sandboxes — which also meant any tunnel on that
 * service, including an attacker's, was reachable. The policy is now
 * re-applied on every code-running turn, so a rotated host is picked up on the
 * next turn and the wildcard buys nothing.
 *
 * `null` for missing / unparseable / localhost, so the caller drops the tier.
 */
export const detectBackendHost = (): string | null => {
  const raw = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
  if (raw === undefined || raw === "") return null;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  if (host === "" || host === "localhost") return null;
  return host;
};

/** Compose the tiers into what `Sandbox.create` / `updateNetwork` take. */
export const buildSandboxNetworkPolicy = (
  input: SandboxNetworkPolicyInput,
): SandboxNetworkPolicy => {
  const policy = input.orgPolicy ?? DEFAULT_ORGANIZATION_SANDBOX_POLICY;

  const allow = new Set<string>();

  // platform — the sandbox cannot do its job without calling us back.
  if (input.backendHost !== null) allow.add(input.backendHost);

  // providers — the org connected these apps, and their bytes do not come
  // through the Nango proxy. Present in every mode for that reason: removing
  // the connection is what removes the host.
  for (const host of input.providerHosts ?? []) allow.add(host);

  if (policy.egressMode !== "platform_only") {
    for (const host of SANDBOX_EGRESS_TIERS.packages) allow.add(host);
  }

  if (policy.egressMode === "packages_plus_domains") {
    for (const host of policy.extraDomains) allow.add(host);
  }

  // Sorted so an unchanged policy hashes to the same fingerprint and does not
  // trigger a pointless `updateNetwork` round trip on every turn.
  const allowOut = [...allow].sort();

  const brokered =
    input.brokeredJwt !== undefined &&
    input.brokeredJwt !== "" &&
    input.backendHost !== null;

  if (!brokered) return { allowOut, denyOut: [ALL_TRAFFIC] };

  return {
    allowOut,
    denyOut: [ALL_TRAFFIC],
    rules: {
      [String(input.backendHost)]: [
        {
          transform: {
            headers: { Authorization: `Bearer ${String(input.brokeredJwt)}` },
          },
        },
      ],
    },
  };
};

/**
 * Cheap identity of a policy, for skipping a redundant `updateNetwork`.
 *
 * The brokered credential is represented by a flag, never by its value: a
 * fingerprint is logged and compared, and a JWT rotates every turn anyway, so
 * hashing it would defeat the skip AND put a credential where it does not
 * belong.
 */
export const policyFingerprint = (policy: SandboxNetworkPolicy): string =>
  [
    policy.allowOut.join(","),
    policy.denyOut.join(","),
    policy.rules === undefined ? "no-rules" : "rules",
  ].join("|");
