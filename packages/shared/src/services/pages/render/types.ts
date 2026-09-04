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
  /**
   * What this frame is OF, when the label alone does not say — the click that
   * opened an overlay. Reaches the critic as the image's caption, so a panel is
   * judged as the answer to a control rather than as a loose screenshot.
   */
  caption?: string;
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
  kind: "row" | "button" | "pointer" | "link";
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
  /**
   * That overlay's subtree as indented text — roles, own text, input types and
   * placeholders — capped, and only for the first few overlays of a pass.
   *
   * Kept for the GATE, which reasons over structure — empty panel, raw uuid,
   * `[object Object]` — and needs no picture to do it. The critic now also
   * receives a capture of each overlay (`caption` on the shot): the text tree
   * carries what is in a panel, never how it looks, and judging overlays on
   * structure alone is why pages whose page-level design scored well shipped
   * with modals that did not.
   */
  overlaySnapshot?: string;
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

/**
 * What one synthetic drag observed, plus the counts around it.
 *
 * The click pass never drags, so drag wiring was the one interaction no gate
 * could see — the shipped failure mode was a board whose cards stopped being
 * draggable after the first re-render (registration torn down by the page's
 * own bind helper) while every screenshot and click looked perfect.
 */
export interface PageRenderDrag {
  /** `[draggable="true"]` elements visible when the page first mounted. */
  draggablesAtMount: number;
  /** Same count at the start of the drag pass. */
  draggablesBeforeDrag: number;
  /** A drop target called preventDefault on dragover — something is listening. */
  dragoverAccepted: boolean;
  /** The drop event itself was handled (default prevented). */
  dropHandled: boolean;
  /** The DOM changed during the drag — hover state, reorder, anything. */
  domChanged: boolean;
  /**
   * The count after drop and dragend settled. Zero, after a drag that changed
   * the DOM, on a page that had draggables, is the teardown bug: every
   * re-render unregisters the elements it re-renders.
   */
  draggablesAfterDrop: number;
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
   * Operation ids the page asked the bridge to run during the click pass.
   *
   * The one thing that separates a control that writes from a control that
   * pretends to: the harness answers `ops.run` without executing anything, so a
   * real call and a faked one look identical on screen and in the DOM — a
   * success toast is a mutation either way. Counting the calls is what makes
   * the difference observable.
   */
  opsRuns: string[];
  /**
   * Clickable controls the probe deliberately did not click, because they were
   * already in the state a click would set — the selected tab, the active
   * segment, the checked toggle.
   *
   * Absent when there were none. It exists so a reader is not left assuming
   * every control was tried: clicking one of these changes nothing BY DESIGN,
   * and reporting that as a dead control blocked two pages that were fine.
   */
  skippedActive?: number;
  /** Present when the page had draggable elements at mount; see the type. */
  drag?: PageRenderDrag;
  /**
   * The views this page declares, when it declares any — the same derivation
   * the compiler used, so the gate can say "this route rendered nothing"
   * about a route that exists rather than about a URL someone typed.
   */
  routes?: string[];
  /**
   * Addresses something on the page linked to that no view answers.
   *
   * Reported by the frame's router, not inferred here: only it knows what its
   * table matched. Kept out of `pageErrors` because it is not a crash — the
   * page runs, one of its links just leads to an empty view, and a reader
   * finds that before anyone else does.
   */
  routeMisses?: string[];
  /** Filenames the page asked the host to save during the click pass. */
  downloads?: string[];
  /**
   * Set when no browser was reachable. The review then proceeds on whatever it
   * has rather than failing the page for our own infrastructure.
   */
  degraded?: string;
}
