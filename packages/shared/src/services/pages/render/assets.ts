/**
 * Serves the versioned page-runtime bundle to the headless frame.
 *
 * The bundle is built and committed in the FRONTEND repo
 * (`app/public/page-runtime/<version>/`), which this container may or may not
 * have on disk. Three resolutions, cheapest first:
 *   1. `PAGE_RUNTIME_DIR` — an explicit mount, the deployment's escape hatch;
 *   2. the sibling checkout, which is how a dev machine is laid out;
 *   3. `APP_URL` over HTTP, cached in memory for the process lifetime — the
 *      production path, where only the frontend deploy carries the assets.
 *
 * Cached by `<version>/<file>`; a runtime rebuild bumps the version, so a
 * stale entry cannot outlive its bundle.
 */

const DEV_GUESS = new URL(
  "../../../../../../../app/public/page-runtime/",
  import.meta.url,
).pathname;

const cache = new Map<string, Uint8Array>();
const misses = new Set<string>();

const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  woff: "font/woff",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
};

export const assetContentType = (path: string): string => {
  const ext = path.split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
};

const readLocal = async (
  root: string,
  relative: string,
): Promise<Uint8Array | null> => {
  if (root === "") return null;
  const file = Bun.file(`${root.replace(/\/$/, "")}/${relative}`);
  return (await file.exists())
    ? new Uint8Array(await file.arrayBuffer())
    : null;
};

/**
 * `<version>/<file...>` — e.g. `v1/runtime.css`, `v1/chunks/abc.js`.
 * Returns null when the asset genuinely does not exist anywhere, so the
 * harness answers 404 rather than serving an empty body the frame would
 * fail on silently.
 */
export const readRuntimeAsset = async (
  relative: string,
): Promise<Uint8Array | null> => {
  const clean = relative.replace(/^\/+/, "");
  // The path is built from an import specifier, never from page content, but
  // this is a file server: refuse traversal on principle.
  if (clean.includes("..")) return null;

  const cached = cache.get(clean);
  if (cached) return cached;
  if (misses.has(clean)) return null;

  const fromEnv = await readLocal(Bun.env.PAGE_RUNTIME_DIR ?? "", clean);
  const bytes = fromEnv ?? (await readLocal(DEV_GUESS, clean));
  if (bytes) {
    cache.set(clean, bytes);
    return bytes;
  }

  const appUrl = (Bun.env.APP_URL ?? "").replace(/\/$/, "");
  if (appUrl !== "") {
    const response = await fetch(`${appUrl}/page-runtime/${clean}`).catch(
      () => null,
    );
    if (response?.ok === true) {
      const fetched = new Uint8Array(await response.arrayBuffer());
      cache.set(clean, fetched);
      return fetched;
    }
  }

  misses.add(clean);
  return null;
};

/** True when the bundle is reachable at all — a renderer with no assets would
 * screenshot a blank frame and blame the page for it. */
export const runtimeAssetsAvailable = async (
  version: string,
): Promise<boolean> => (await readRuntimeAsset(`${version}/sdk.js`)) !== null;
