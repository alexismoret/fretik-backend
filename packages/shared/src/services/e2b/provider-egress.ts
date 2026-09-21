import { getProvider } from "../../external-apps/registry";

/**
 * Egress hosts a team's ACTIVE external-app connections need the sandbox to
 * reach, read off each provider's manifest (`sandboxEgressHosts`).
 *
 * Why it is derived per turn rather than listed once: the old allowlist
 * carried `*.sharepoint.com` for every tenant on the platform, all the time,
 * whether or not the team had ever connected SharePoint. Deriving it from the
 * live connections makes disconnecting the app the thing that closes the host
 * — no second place to remember.
 *
 * Pure, so the policy builder stays testable without a registry: an unknown
 * key contributes nothing rather than throwing, because a provider can be
 * retired between a connection being stored and this turn running.
 */
export const collectProviderEgressHosts = (
  providerKeys: readonly string[],
): string[] => {
  const hosts = new Set<string>();
  for (const key of providerKeys) {
    for (const host of getProvider(key)?.manifest.sandboxEgressHosts ?? []) {
      hosts.add(host);
    }
  }
  return [...hosts].sort();
};
