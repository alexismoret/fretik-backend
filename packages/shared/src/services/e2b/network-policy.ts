import { ALL_TRAFFIC, type SandboxNetworkRules } from "e2b";
import {
  DEFAULT_ORGANIZATION_SANDBOX_POLICY,
  type OrganizationSandboxPolicy,
} from "../../schemas/sandbox-policy";
import { detectBackendHost, SANDBOX_EGRESS_TIERS } from "./egress-tiers";

/**
 * Egress policy for the code sandbox. Default is deny-all
 * (`denyOut: [ALL_TRAFFIC]`); only what `allowOut` names is reachable.
 *
 * The policy is composed from TIERS rather than one list, because the four
 * sources answer to different owners and change at different times: our own
 * backend host comes from the deployment, provider hosts from the team's live
 * connections, the registries from `egress-tiers.ts`, and the extra domains
 * from an org admin. Composition is a pure function so every combination is
 * testable
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

export { detectBackendHost, SANDBOX_EGRESS_TIERS };

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
