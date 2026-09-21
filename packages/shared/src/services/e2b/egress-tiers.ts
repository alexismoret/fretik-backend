/**
 * The egress data a reader needs without the machinery that applies it.
 *
 * Split from `network-policy.ts` for one measured reason: that module imports
 * the E2B SDK (for `ALL_TRAFFIC`), and pulling that graph in costs 404 ms —
 * which the settings API would otherwise pay at boot to show an admin two
 * lists of hostnames. Nothing here has a runtime dependency.
 *
 * `network-policy.ts` re-exports both, so there is still one definition and
 * callers already on it need no change.
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
