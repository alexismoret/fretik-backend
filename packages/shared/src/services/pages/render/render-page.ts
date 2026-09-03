import type {
  PageCompiled,
  PageDataResponse,
  PageDefinition,
} from "../../../schemas/pages";
import { runPageData } from "../run-page-data";
import { assetContentType, readRuntimeAsset } from "./assets";
import { buildHarnessHtml } from "./harness";
import { buildPageSrcdoc } from "./srcdoc";
import type {
  PageRenderDrag,
  PageRenderInteraction,
  PageRenderLayout,
  PageRenderResult,
  PageRenderShot,
  PageRenderViewport,
} from "./types";
import { BrowserUnavailableError, withRenderView } from "./webview";

/**
 * Renders a compiled page in a headless browser and reports what a person
 * would see and hit.
 *
 * Four captures, each answering a question the source cannot:
 *   - desktop, with the page's real rows;
 *   - tablet, the laptop width where a grid reflows and a bounded region gains
 *     a row it was never sized for;
 *   - mobile, same state — the responsive break nobody asks for and every
 *     model forgets;
 *   - desktop with every dataset emptied — the state a page is built for on
 *     day one and forgets by day two.
 * Plus desktop-bottom when the page runs past one screen.
 * Then a scripted interaction pass, because the two worst bugs found in the v3
 * audit (a slideover and a modal that open EMPTY) are invisible until clicked.
 */

/** The page's own viewport: the app's content area, not a browser window. */
const DESKTOP: PageRenderViewport = {
  label: "desktop",
  width: 1280,
  height: 860,
};
const MOBILE: PageRenderViewport = { label: "mobile", width: 390, height: 844 };
/**
 * The width nobody captures and everybody uses. 1280 and 390 sit on either side
 * of the Tailwind band `md`(768)-`xl`(1280), and a grid that reflows INSIDE it
 * was invisible to both: a real board declaring `md:grid-cols-2 xl:grid-cols-4`
 * inside a `h-[calc(100dvh-350px)]` box rendered four lanes on one row at 1280
 * — correct — and two rows of two at a laptop width, halving every lane to one
 * visible card out of six. A height bound is written for a column count and
 * breaks when the breakpoint changes the ROW count.
 */
const TABLET: PageRenderViewport = {
  label: "tablet",
  width: 1024,
  height: 800,
};

const SETTLE_TIMEOUT_MS = 12_000;
const SETTLE_QUIET_MS = 350;
const PROBE_TIMEOUT_MS = 20_000;
const REFLOW_MS = 400;

interface ProbeStat {
  mounted: boolean;
  textLength: number;
  horizontalOverflow: boolean;
  clipped: number;
  draggables: number;
}

/** The probe answers over postMessage, so its payload is untyped JSON on
 * arrival. These narrow it once, here, rather than casting at each use. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;

const asProbeStat = (value: unknown): ProbeStat | null => {
  const record = asRecord(value);
  if (!record) return null;
  return {
    mounted: record["mounted"] === true,
    textLength:
      typeof record["textLength"] === "number" ? record["textLength"] : 0,
    horizontalOverflow: record["horizontalOverflow"] === true,
    clipped: typeof record["clipped"] === "number" ? record["clipped"] : 0,
    draggables:
      typeof record["draggables"] === "number" ? record["draggables"] : 0,
  };
};

const asDrag = (
  value: unknown,
  draggablesAtMount: number,
): PageRenderDrag | null => {
  const record = asRecord(value);
  if (!record) return null;
  return {
    draggablesAtMount,
    draggablesBeforeDrag:
      typeof record["draggables"] === "number" ? record["draggables"] : 0,
    dragoverAccepted: record["dragoverAccepted"] === true,
    dropHandled: record["dropHandled"] === true,
    domChanged: record["domChanged"] === true,
    draggablesAfterDrop:
      typeof record["draggablesAfter"] === "number"
        ? record["draggablesAfter"]
        : 0,
  };
};

/** Matches the probe's own cap; enforced again on this side of the frame. */
const OVERLAY_SNAPSHOT_LIMIT = 1400;

/**
 * Screens of content past which a top and a bottom no longer cover the page.
 * At 2.5 the unseen band is at most about a screen and a half; below it, a
 * midpoint capture would mostly repeat one of the two it sits between.
 */
const TALL_PAGE_RATIO = 2.5;

const asGeometry = (
  value: unknown,
): { scrollHeight: number; viewport: number } | null => {
  const record = asRecord(value);
  if (!record) return null;
  const scrollHeight = record["scrollHeight"];
  const viewport = record["viewport"];
  if (typeof scrollHeight !== "number" || typeof viewport !== "number") {
    return null;
  }
  return { scrollHeight, viewport };
};

const asInteractions = (value: unknown): PageRenderInteraction[] => {
  if (!Array.isArray(value)) return [];
  const out: PageRenderInteraction[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const kind = record["kind"];
    out.push({
      target:
        typeof record["target"] === "string" ? record["target"] : "(unnamed)",
      kind:
        kind === "row" || kind === "button" || kind === "pointer"
          ? kind
          : "pointer",
      domChanged: record["domChanged"] === true,
      overlayOpened: record["overlayOpened"] === true,
      overlayTextLength:
        typeof record["overlayTextLength"] === "number"
          ? record["overlayTextLength"]
          : 0,
      overlayContentCount:
        typeof record["overlayContentCount"] === "number"
          ? record["overlayContentCount"]
          : 0,
      // Re-capped on this side too. The probe bounds it, but the probe runs in
      // the page's own frame: everything crossing that boundary is treated as
      // something the page could have written, and an unbounded string here
      // would land straight in a model's context.
      ...(typeof record["overlaySnapshot"] === "string" &&
      record["overlaySnapshot"].length > 0
        ? {
            overlaySnapshot: record["overlaySnapshot"].slice(
              0,
              OVERLAY_SNAPSHOT_LIMIT,
            ),
          }
        : {}),
    });
  }
  return out;
};

/** One step of the stepped click pass, or null once the pass is exhausted. */
const asInteractionStep = (value: unknown): PageRenderInteraction | null => {
  const record = asRecord(value);
  if (!record || record["done"] === true) return null;
  return asInteractions([value])[0] ?? null;
};

/**
 * How many overlays a review is worth capturing.
 *
 * Each one is a full image in the critic's context, and pages repeat their
 * panels — five rows opening the same slideover teach nothing after the first.
 * Matched to the probe's own snapshot cap so the text tree and the picture
 * cover the same overlays.
 */
const MAX_OVERLAY_SHOTS = 4;

/** Same datasets, no rows — the empty state, without waiting for a quiet day. */
const emptyFixtures = (
  datasets: PageDataResponse["datasets"],
): PageDataResponse["datasets"] => {
  const out: PageDataResponse["datasets"] = {};
  for (const [id, result] of Object.entries(datasets)) {
    out[id] =
      result.status === "ok"
        ? { ...result, rows: [], truncated: false, totalCount: 0 }
        : result;
  }
  return out;
};

const waitFor = async <T>(
  attempt: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value !== null) return value;
    await Bun.sleep(120);
  }
  return null;
};

export const renderPage = async (params: {
  compiled: PageCompiled;
  definition: PageDefinition;
  teamId: string;
  userId: string | null;
  pageName: string;
  dark?: boolean;
  locale?: "en" | "fr";
}): Promise<PageRenderResult> => {
  const empty: PageRenderResult = {
    mounted: false,
    settled: false,
    shots: [],
    interactions: [],
    layout: {},
    consoleErrors: [],
    pageErrors: [],
    opsRuns: [],
  };

  const runtimeReady =
    (await readRuntimeAsset(`${params.compiled.runtimeVersion}/sdk.js`)) !==
    null;
  if (!runtimeReady) {
    return {
      ...empty,
      degraded: `page-runtime ${params.compiled.runtimeVersion} assets not reachable — set PAGE_RUNTIME_DIR or APP_URL.`,
    };
  }

  // Fixtures are captured BEFORE the browser starts: a review must not depend
  // on query latency, and two reviews of one page must see the same rows.
  const { datasets } = await runPageData({
    definition: params.definition,
    teamId: params.teamId,
    userId: params.userId,
    variables: {},
  });

  const nonce = Bun.randomUUIDv7();
  /**
   * The name the BROWSER reaches this harness by.
   *
   * The frame is served by an ephemeral listener in this process, and the
   * browser is the one that fetches it — so with `PAGE_RENDER_BROWSER_WS`
   * pointing at a browser in its OWN container, `127.0.0.1` is that
   * container's loopback and resolves to nothing: every render comes back
   * blank, which reads as a broken page rather than a broken network.
   * `PAGE_RENDER_SELF_HOST` is the name that container can reach us by (a
   * compose service name, an IP). It also widens the bind, so it is opt-in
   * rather than derived from `PAGE_RENDER_BROWSER_WS` — the harness serves
   * this page's data fixtures, and loopback is the right default.
   */
  const selfHost = Bun.env.PAGE_RENDER_SELF_HOST ?? "";
  /** Set once the listener is up; the harness needs its own origin to build
   * the CSP, the import map and the bridge's expected parent origin. */
  let origin = "";
  const server = Bun.serve({
    port: 0,
    hostname: selfHost === "" ? "127.0.0.1" : "0.0.0.0",
    idleTimeout: 30,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/page-runtime/")) {
        const bytes = await readRuntimeAsset(
          pathname.slice("/page-runtime/".length),
        );
        return bytes
          ? new Response(bytes, {
              headers: {
                "content-type": assetContentType(pathname),
                // The frame is an OPAQUE origin, so every module import it
                // makes is cross-origin and sends `Origin: null`. Without
                // this the imports fail CORS and the page never mounts — a
                // blank screenshot that would read as "the page is broken".
                // The app serves these assets with the same header.
                "access-control-allow-origin": "*",
              },
            })
          : new Response("not found", { status: 404 });
      }
      const html = buildHarnessHtml({
        srcdoc: buildPageSrcdoc({
          compiled: params.compiled,
          nonce,
          parentOrigin: origin,
          probe: true,
        }),
        nonce,
        parentOrigin: origin,
        fixtures: pathname === "/empty" ? emptyFixtures(datasets) : datasets,
        pageName: params.pageName,
        dark: params.dark ?? false,
        locale: params.locale ?? "en",
        accent: params.definition.theme?.accent ?? null,
      });
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  origin = `http://${selfHost === "" ? "127.0.0.1" : selfHost}:${(server.port ?? 0).toString()}`;

  try {
    return await withRenderView(async (view, consoleErrors) => {
      const shots: PageRenderShot[] = [];
      const layout: Record<string, PageRenderLayout> = {};

      const settle = async (): Promise<boolean> =>
        (await waitFor(
          async () =>
            (await view.evaluate<boolean>(
              `window.__settled(${SETTLE_QUIET_MS.toString()})`,
            ))
              ? true
              : null,
          SETTLE_TIMEOUT_MS,
        )) === true;

      const probe = async (cmd: string, arg?: number): Promise<unknown> => {
        const id = await view.evaluate<number>(
          `window.__probe(${JSON.stringify(cmd)}, ${arg === undefined ? "undefined" : arg.toString()})`,
        );
        const raw = await waitFor(
          () =>
            view.evaluate<string | null>(
              `window.__probeResult(${id.toString()})`,
            ),
          PROBE_TIMEOUT_MS,
        );
        return raw === null ? null : JSON.parse(raw);
      };

      const capture = async (viewport: PageRenderViewport): Promise<void> => {
        const stat = asProbeStat(await probe("stat"));
        if (stat) {
          layout[viewport.label] = {
            horizontalOverflow: stat.horizontalOverflow,
            clipped: stat.clipped,
            textLength: stat.textLength,
          };
        }
        shots.push({
          label: viewport.label,
          width: viewport.width,
          height: viewport.height,
          png: await view.screenshot(),
        });
      };

      await view.resize(DESKTOP.width, DESKTOP.height);
      await view.navigate(origin);
      const settled = await settle();

      const mountStat = asProbeStat(await probe("stat"));
      const mounted = mountStat?.mounted === true;
      await capture(DESKTOP);

      // The half nobody was looking at. A capture is the VIEWPORT, so a page
      // that runs three screens deep was being judged on its top third — and
      // the region that grows without bound is precisely the one that looks
      // fine at the top. Skipped when the page fits: a second identical
      // capture would cost image tokens and teach the critic nothing.
      //
      // Past `TALL_PAGE_RATIO` screens, top-and-bottom stops covering it: a
      // page of five sections has three nobody has ever looked at, and that is
      // exactly the shape a large multi-view page takes. One more capture at
      // the midpoint bounds the blind region at roughly a screen and a half,
      // whatever the page's height.
      const geometry = asGeometry(await probe("geometry"));
      const tall =
        geometry !== null &&
        geometry.viewport > 0 &&
        geometry.scrollHeight > geometry.viewport * TALL_PAGE_RATIO;
      if (tall) {
        await probe("scrollTo", 0.5);
        await Bun.sleep(REFLOW_MS);
        await capture({ ...DESKTOP, label: "desktop-mid" });
      }
      const scrolled = await probe("scrollEnd");
      if (
        typeof scrolled === "object" &&
        scrolled !== null &&
        Reflect.get(scrolled, "scrolled") === true
      ) {
        // `capture` and not a bare screenshot: `stat()` at the bottom is what
        // finally puts `desktop-bottom` in `layout`, so the gate can see a
        // table running sideways or a region clipped below the fold. It was
        // pushing a picture and measuring nothing.
        await Bun.sleep(REFLOW_MS);
        await capture({ ...DESKTOP, label: "desktop-bottom" });
      }
      await probe("scrollStart");

      await view.resize(TABLET.width, TABLET.height);
      await Bun.sleep(REFLOW_MS);
      await capture(TABLET);

      await view.resize(MOBILE.width, MOBILE.height);
      await Bun.sleep(REFLOW_MS);
      await capture(MOBILE);
      await view.resize(DESKTOP.width, DESKTOP.height);
      await Bun.sleep(REFLOW_MS);

      // The drag pass, before the clicks: it needs the board in its arrival
      // state, and it runs only after every capture so a card it moves cannot
      // change what the critic sees. Skipped for pages with nothing draggable.
      const drag =
        mountStat !== null && mountStat.draggables > 0
          ? asDrag(await probe("dragCheck"), mountStat.draggables)
          : null;

      // Clicks last: they mutate the page, so every capture above is of the
      // state a visitor actually arrives in.
      //
      // Stepped, so an overlay can be photographed while it is still open. It
      // used to be one call that clicked everything and dismissed each panel
      // on its way, which left the critic judging modals on a text tree — and
      // pages whose own layout scored well kept shipping overlays that did not.
      const interactions: PageRenderInteraction[] = [];
      const begun = asRecord(await probe("interactBegin"));
      const steps = typeof begun?.["count"] === "number" ? begun["count"] : 0;
      // Controls the probe left alone because they were already in the state a
      // click would set. Reported so the gate can say what it did NOT measure
      // instead of a reader assuming every control was tried.
      const skippedActive =
        typeof begun?.["skippedActive"] === "number"
          ? begun["skippedActive"]
          : 0;
      let overlayShots = 0;
      for (let index = 0; index < steps; index += 1) {
        const step = asInteractionStep(await probe("interactStep"));
        if (!step) break;
        interactions.push(step);
        if (!step.overlayOpened || overlayShots >= MAX_OVERLAY_SHOTS) continue;
        overlayShots += 1;
        await Bun.sleep(REFLOW_MS);
        shots.push({
          label: `overlay-${overlayShots.toString()}`,
          width: DESKTOP.width,
          height: DESKTOP.height,
          png: await view.screenshot(),
          caption: step.target,
        });
      }
      await probe("interactEnd");

      const pageErrors = await view.evaluate<string[]>(
        "window.__STATE__.pageErrors",
      );
      const opsRuns =
        (await view.evaluate<string[]>("window.__STATE__.opsRuns")) ?? [];

      await view.navigate(`${origin}/empty`);
      await settle();
      await capture({ ...DESKTOP, label: "empty-state" });

      return {
        mounted,
        settled,
        shots,
        interactions,
        layout,
        consoleErrors: [...consoleErrors],
        pageErrors,
        opsRuns,
        ...(skippedActive > 0 ? { skippedActive } : {}),
        ...(drag ? { drag } : {}),
      };
    });
  } catch (error) {
    if (error instanceof BrowserUnavailableError)
      return { ...empty, degraded: error.message };
    throw error;
  } finally {
    await server.stop(true);
  }
};
