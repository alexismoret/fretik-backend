/**
 * Shapes exchanged with the headless page renderer.
 *
 * The renderer answers the question the compiler cannot: does this page WORK
 * when someone looks at it and clicks something. A compile failure refuses the
 * write; this reports what survives compilation and still ships broken.
 */

export interface PageRenderViewport {
  /** Carried into the review payload so the evaluator can name the shot. */
  label: string;
  /** The PAGE's own viewport — the iframe's inner size, not a browser window. */
  width: number;
  height: number;
}

/** One captured frame. `png` is raw bytes; the AI layer base64s them itself. */
export interface PageRenderShot {
  label: string;
  width: number;
  height: number;
  png: Uint8Array;
}

/**
 * One scripted interaction. `domChanged` answers "did clicking this do anything
 * at all"; `overlayTextLength` answers "did the overlay it opened have any
 * content" — the two questions a screenshot cannot ask, and the two that catch
 * the interaction bugs found in the v3 audit (empty slideover, empty modal).
 */
export interface PageRenderInteraction {
  /** Human-readable target, e.g. `row "GEODIS France"`. */
  target: string;
  /** How the target advertised itself as clickable. */
  kind: "row" | "button" | "pointer";
  domChanged: boolean;
  overlayOpened: boolean;
  /** Visible characters inside the overlay the click opened, when one opened. */
  overlayTextLength: number;
  /**
   * Content elements (inputs, rows, paragraphs, …) inside that overlay,
   * buttons excluded. Zero with almost no text is the empty-overlay bug —
   * and unlike a character count this does not mistake a form of
   * placeholder-only inputs for an empty panel.
   */
  overlayContentCount: number;
}

/** Layout facts measured in the frame, cheap and objective. */
export interface PageRenderLayout {
  /** True when content overflows horizontally — the page scrolls sideways. */
  horizontalOverflow: boolean;
  /**
   * Content elements sitting outside the viewport that nothing can scroll to.
   * The sideways-scroll flag misses this entirely: a layout that ignores the
   * width inside a clipping shell reports no overflow while half of it is cut
   * off, which is what a narrow viewport actually does to an unresponsive page.
   */
  clipped: number;
  /** Visible text length; a near-empty page is a tell even when it "renders". */
  textLength: number;
}

export interface PageRenderResult {
  /** False when the page never mounted — everything else is then meaningless. */
  mounted: boolean;
  /** False when the settle signal never arrived before the deadline. */
  settled: boolean;
  shots: PageRenderShot[];
  interactions: PageRenderInteraction[];
  layout: Record<string, PageRenderLayout>;
  /** `console.error` / `console.warn` raised anywhere in the frame. */
  consoleErrors: string[];
  /** What the page reported through `fretik.report.error` (window, promise, vue). */
  pageErrors: string[];
  /**
   * Set when no browser was reachable. The review then proceeds on whatever it
   * has rather than failing the page for our own infrastructure.
   */
  degraded?: string;
}
