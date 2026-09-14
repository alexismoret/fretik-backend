/**
 * Path resolution and name matching — the half of this provider that has
 * nothing to do with either protocol.
 *
 * Two jobs:
 *
 *  1. **Resolve every agent-supplied path against the connection's root.**
 *     A connection can pin a `root_path` (`/edi/in` for a partner drop
 *     folder), and then `orders/` means `/edi/in/orders/`. Without the pin,
 *     paths stay as given and the server's own landing directory applies.
 *
 *  2. **Keep a path inside that root.** `..` is a legal path segment, so a
 *     pinned connection that resolves it naively is pinned to nothing. The
 *     normalization below collapses `.`/`..` BEFORE the prefix check, which
 *     is the only order that works: checking the raw string lets
 *     `orders/../../etc` through, and checking after the server resolves it
 *     is a round-trip too late.
 *
 * The root is a scoping convenience, not a security boundary — the server's
 * own account permissions are that. But a connection a team pinned to one
 * folder should behave like it, including when the agent gets creative.
 */

/** Collapse `.` / `..` / duplicate separators. Keeps the leading `/`. */
export const normalizePath = (path: string): string => {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // A `..` that would climb past a relative path's start is kept, so
      // the confinement check below can see it and refuse.
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined;
};

export class PathOutsideRootError extends Error {
  constructor(path: string, root: string) {
    super(
      `Path "${path}" resolves outside this connection's root folder ("${root}").`,
    );
    this.name = "PathOutsideRootError";
  }
}

/**
 * Resolve one agent-supplied path against the connection's root.
 *
 * With no root, the path is passed through normalized — an empty path
 * becoming `.` so the server answers with its own working directory rather
 * than with an error about an empty argument.
 */
export const resolveRemotePath = (rootPath: string, path: string): string => {
  const root = rootPath.trim();
  const given = path.trim();

  if (root === "") {
    const normalized = normalizePath(given);
    return normalized === "" ? "." : normalized;
  }

  const normalizedRoot = normalizePath(
    root.startsWith("/") ? root : `/${root}`,
  );
  // An absolute path from the agent is interpreted as root-relative: the
  // agent is shown paths under the root and echoing one back must land in
  // the same place it was read from.
  const resolved = normalizePath(
    `${normalizedRoot}/${given.replace(/^\/+/, "")}`,
  );
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(`${normalizedRoot}/`)
  ) {
    throw new PathOutsideRootError(path, normalizedRoot);
  }
  return resolved;
};

/**
 * Hide the root from what the agent reads back.
 *
 * A connection pinned to `/edi/in` should read as if `/edi/in` were the
 * server's root, or the agent learns a prefix it then re-sends — and
 * `resolveRemotePath` would prepend the root a second time.
 */
export const toDisplayPath = (
  rootPath: string,
  absolutePath: string,
): string => {
  const root = rootPath.trim();
  if (root === "") return absolutePath;
  const normalizedRoot = normalizePath(
    root.startsWith("/") ? root : `/${root}`,
  );
  if (absolutePath === normalizedRoot) return "/";
  if (absolutePath.startsWith(`${normalizedRoot}/`)) {
    return absolutePath.slice(normalizedRoot.length);
  }
  return absolutePath;
};

/**
 * Match a file NAME against a glob.
 *
 * `Bun.Glob` is the whole implementation — no dependency, and it already
 * speaks the syntax people expect from a shell (`*.csv`, `ORDER_??.xml`,
 * `{in,out}/*.edi`). Matching is case-insensitive because half of the FTP
 * servers in this space are Windows, where `ORDER.CSV` and `order.csv` are
 * one file and a case-sensitive filter would answer "no files" on a folder
 * that plainly has them.
 */
export const matchesPattern = (name: string, pattern: string): boolean => {
  if (pattern.trim() === "") return true;
  return new Bun.Glob(pattern.toLowerCase()).match(name.toLowerCase());
};
