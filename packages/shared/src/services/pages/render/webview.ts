/**
 * The ONLY file that touches `Bun.WebView`.
 *
 * That API is marked experimental, so every call to it is contained here
 * behind `RenderView`. If it changes shape, this file is the whole blast
 * radius — and the documented fallback (a ~200-line raw CDP client over
 * `Bun.spawn` + a native WebSocket) slots in behind the same interface without
 * touching the renderer, the harness or the probe.
 *
 * Browser resolution, cheapest and safest first:
 *   1. `PAGE_RENDER_BROWSER_WS` — a browser running in ITS OWN container
 *      (browserless on Dokploy). The production shape: the service image
 *      carries no Chrome, and a browser OOM cannot take the chatbot down.
 *   2. an explicit local binary (`PAGE_RENDER_CHROMIUM_PATH` / `BUN_CHROME_PATH`).
 *   3. macOS default — WKWebView, a system framework, nothing to install.
 *   4. Linux without any of the above — auto-detect an installed Chrome.
 * When none resolves, rendering is DEGRADED, never fatal: a page is not bad
 * because our browser is missing.
 *
 * Cost, measured: one browser is ~9 processes / ~900 MB and 1.6 s to start,
 * while a SECOND view is one more tab (+210 MB) and re-navigating an existing
 * view is ~64 ms. So views are pooled and reused, and concurrency is capped —
 * exactly like the Tailwind subprocesses in `compile.ts`.
 */

/** Two at a time: past that, tabs compete for the same cores for no gain. */
const MAX_CONCURRENT_VIEWS = 2;

const CONTAINER_FLAGS = [
  // No user namespaces as `USER bun`; the frame is server-compiled output in
  // an opaque origin with `connect-src 'none'`, so the exposure is bounded.
  "--no-sandbox",
  "--disable-dev-shm-usage",
  // Stable pixels for the judge: same colours, no scrollbar furniture.
  "--force-color-profile=srgb",
  "--hide-scrollbars",
];

export interface RenderView {
  navigate: (url: string) => Promise<void>;
  evaluate: <T>(script: string) => Promise<T>;
  resize: (width: number, height: number) => Promise<void>;
  screenshot: () => Promise<Uint8Array>;
}

const resolveBackend = (): Bun.WebView.ConstructorOptions["backend"] => {
  const ws = Bun.env.PAGE_RENDER_BROWSER_WS ?? "";
  if (ws !== "") return { type: "chrome", url: ws };

  const path =
    Bun.env.PAGE_RENDER_CHROMIUM_PATH ?? Bun.env.BUN_CHROME_PATH ?? "";
  if (path !== "") return { type: "chrome", path, argv: CONTAINER_FLAGS };

  // WKWebView needs nothing installed; anywhere else, Chrome is the only option
  // and the constructor throws when it cannot find one (handled by the caller).
  if (process.platform === "darwin") return undefined;
  return { type: "chrome", argv: CONTAINER_FLAGS };
};

interface PooledView {
  view: Bun.WebView;
  /** Cleared IN PLACE per acquisition — the console callback closes over this
   * exact array, so replacing it would silently orphan the capture. */
  sink: string[];
}

const pool: PooledView[] = [];
let live = 0;
const queue: ((entry: PooledView) => void)[] = [];

export class BrowserUnavailableError extends Error {}

const createView = (): PooledView => {
  const sink: string[] = [];
  try {
    const view = new Bun.WebView({
      width: 1280,
      height: 860,
      backend: resolveBackend(),
      dataStore: "ephemeral",
      console: (type: string, ...args: unknown[]) => {
        if (type !== "error" && type !== "warn") return;
        const text = args
          .map((arg) =>
            typeof arg === "string" ? arg : (JSON.stringify(arg) ?? ""),
          )
          .join(" ");
        if (text.trim() !== "") sink.push(`${type}: ${text.slice(0, 400)}`);
      },
    });
    return { view, sink };
  } catch (error) {
    throw new BrowserUnavailableError(
      `no browser available for page rendering (${error instanceof Error ? error.message : String(error)}). Set PAGE_RENDER_BROWSER_WS to a CDP endpoint, or install Chrome.`,
    );
  }
};

const acquire = async (): Promise<PooledView> => {
  const free = pool.pop();
  if (free) return free;
  if (live < MAX_CONCURRENT_VIEWS) {
    live += 1;
    try {
      return createView();
    } catch (error) {
      live -= 1;
      throw error;
    }
  }
  return new Promise<PooledView>((resolve) => queue.push(resolve));
};

const release = (entry: PooledView, broken: boolean): void => {
  if (broken) {
    try {
      entry.view.close();
    } catch {
      // Already gone; the point was to stop reusing it.
    }
    live -= 1;
    const waiting = queue.shift();
    if (waiting) {
      live += 1;
      try {
        waiting(createView());
      } catch {
        live -= 1;
      }
    }
    return;
  }
  const waiting = queue.shift();
  if (waiting) waiting(entry);
  else pool.push(entry);
};

/**
 * Runs `work` against a pooled view. `consoleErrors` is filled with whatever
 * the frame logged at error/warn level while the work ran.
 *
 * Throws `BrowserUnavailableError` when no browser could be reached — callers
 * degrade rather than fail the page.
 */
export const withRenderView = async <T>(
  work: (view: RenderView, consoleErrors: string[]) => Promise<T>,
): Promise<T> => {
  const entry = await acquire();
  entry.sink.length = 0;
  let broken = false;
  try {
    const api: RenderView = {
      navigate: (url) => entry.view.navigate(url),
      evaluate: <R>(script: string) => entry.view.evaluate<R>(script),
      resize: (width, height) => entry.view.resize(width, height),
      screenshot: async () =>
        new Uint8Array(
          await entry.view.screenshot({ encoding: "buffer", format: "png" }),
        ),
    };
    return await work(api, entry.sink);
  } catch (error) {
    // A view that failed mid-operation may hold a half-dead tab; drop it
    // rather than hand it to the next render.
    broken = true;
    throw error;
  } finally {
    release(entry, broken);
  }
};

/** Test/shutdown helper — closes every pooled view. */
export const closeRenderViews = (): void => {
  for (const entry of pool.splice(0)) {
    try {
      entry.view.close();
    } catch {
      // Nothing to do; we are tearing down.
    }
  }
  live = 0;
};
