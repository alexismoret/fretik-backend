import { EMPTY_OVERLAY_CHARS } from "@fretik/shared/services/pages/render/probe";
import type {
  PageRenderLayout,
  PageRenderResult,
} from "@fretik/shared/services/pages/render/types";

/**
 * The measured half of a review — no model, no opinion, no cost.
 *
 * Every rule here comes from a defect that SHIPPED in v3 and that neither the
 * compiler, a typecheck, a clean console nor a screenshot of the loaded page
 * could see: a slideover wired to the wrong handler signature opened blank, a
 * compose form placed in a modal's trigger slot rendered inline and left the
 * modal empty. Both pages compiled, logged nothing, and looked fine until
 * someone clicked.
 *
 * A finding here outranks any score. The critic can love a page the gate
 * fails — that asymmetry is the point: a vision model asked to grade its own
 * pipeline will find reasons to pass it, a click that changes nothing will not.
 */

/** Deduped and capped: past this the list stops being a fix list. */
const MAX_BLOCKING = 12;

/**
 * Below this many visible characters, the emptied page renders no empty state
 * — the header and a blank region. Two words of "No results" clears it.
 */
const MIN_EMPTY_STATE_CHARS = 25;
/**
 * How close the emptied render may come to the populated one before it stops
 * being an empty state. Deliberately high: a real empty state keeps the
 * chrome — header, tabs, filters, the message itself — so 0.7 would fail an
 * honest page. What it catches is the page that changes almost nothing, which
 * is what a fallback to invented rows looks like from the outside.
 */
const EMPTY_STATE_SAME_RATIO = 0.9;

/**
 * One element hanging past the edge can be a transform or a measurement race;
 * three is a layout that never adapted. Found by the critic before the gate
 * had this rule: a page whose sidebar alone was 510px wide at 390 reported no
 * horizontal overflow, because the shell clipped instead of scrolling.
 */
const MIN_CLIPPED_ELEMENTS = 3;

/** Console noise is quoted, not summarised — the message IS the lead. */
const CONSOLE_MESSAGE_CHARS = 300;
const MAX_CONSOLE_QUOTED = 3;

export interface PageGateResult {
  pass: boolean;
  /** Defects, each phrased as what to fix. Empty when the gate passes. */
  blocking: string[];
  /** Measured facts worth knowing that are not, on their own, defects. */
  observations: string[];
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

/**
 * An object that reached the screen without a formatter, in BOTH the shapes it
 * actually takes.
 *
 * `[object Object]` is the famous one and it is the rarer one here: measured on
 * a real render, Vue interpolation prints an object as its JSON — a money field
 * lands as `{ "amount": 5250, "currencyCode": "EUR" }`. Checking only for the
 * famous string would have missed the common case entirely.
 *
 * The JSON form is matched on `{ "key":`, which a page's own prose does not
 * produce; deliberate JSON would sit in a `<pre>`/`<code>`, and the snapshot
 * emits no line for either.
 */
const STRINGIFIED_OBJECT = /\[object \w+\]|\{\s*"[\w-]+":/;
/**
 * A machine timestamp shown to a person: `2026-08-20T14:31:00Z`. Bounded on
 * both sides so a date a page formatted itself (`2026-08-20`) is not flagged —
 * that one is a legitimate rendering of a `date` field.
 */
const RAW_ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** A uuid, printed where a name belongs. */
const RAW_UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * What the open overlay was holding.
 *
 * These are the same defects the gate already refuses on the page itself — a
 * raw value in front of a user — checked in the one region nothing else can
 * see. The overlay is exactly where they hide: a detail panel is written last,
 * interpolates the record's own fields directly, and is never in a screenshot.
 */
const inspectOverlaySnapshot = (interaction: {
  target: string;
  overlaySnapshot?: string;
}): string[] => {
  const snapshot = interaction.overlaySnapshot;
  if (snapshot === undefined || snapshot.length === 0) return [];
  const defects: string[] = [];
  if (STRINGIFIED_OBJECT.test(snapshot)) {
    defects.push(
      `The overlay opened by ${interaction.target} prints an object instead of a value — money arrives as \`{ amount, currencyCode }\` and a relation as \`[{ id, label }]\`, and one of them reached the template raw. Route it through the dataset's \`fields\` descriptor.`,
    );
  }
  if (RAW_ISO_TIMESTAMP.test(snapshot)) {
    defects.push(
      `The overlay opened by ${interaction.target} shows a raw ISO timestamp. Format it with \`Intl.DateTimeFormat(fretik.context.locale, …)\`.`,
    );
  }
  if (RAW_UUID.test(snapshot)) {
    defects.push(
      `The overlay opened by ${interaction.target} shows a raw uuid. A record id is a key, not a value a person reads — show its \`label\`, and resolve a relation through the \`{ id, label }\` it already carries.`,
    );
  }
  return defects;
};

export const gatePageRender = (
  render: PageRenderResult,
  /** How many datasets the page declares — the `/empty` capture only means
   *  something for a page that has data to lose. */
  declaredDatasets = 0,
): PageGateResult => {
  const blocking: string[] = [];
  const observations: string[] = [];

  if (!render.mounted) {
    blocking.push(
      "The page never mounted — nothing rendered at all. Everything else in this review is meaningless until it does.",
    );
  } else if (!render.settled) {
    observations.push(
      "The page mounted but never went quiet — something re-renders or refetches continuously.",
    );
  }

  for (const message of render.pageErrors.slice(0, MAX_CONSOLE_QUOTED)) {
    blocking.push(
      `The page threw at runtime: ${truncate(message, CONSOLE_MESSAGE_CHARS)}`,
    );
  }

  for (const message of [...new Set(render.consoleErrors)].slice(
    0,
    MAX_CONSOLE_QUOTED,
  )) {
    blocking.push(`Console error: ${truncate(message, CONSOLE_MESSAGE_CHARS)}`);
  }

  for (const interaction of render.interactions) {
    if (
      interaction.overlayOpened &&
      interaction.overlayContentCount === 0 &&
      interaction.overlayTextLength < EMPTY_OVERLAY_CHARS
    ) {
      blocking.push(
        `Clicking ${interaction.target} opens an overlay with nothing in it. Either the handler never receives the item (a Nuxt UI emit passes the EVENT first: \`@select="(e, row) => open(row)"\`) or the content sits in a slot that is not the panel (a modal's default slot is its TRIGGER — the panel is \`#body\`/\`#content\`). Read the component's API with { action: "components" } and re-wire it.`,
      );
      continue;
    }
    if (!interaction.domChanged && !interaction.overlayOpened) {
      blocking.push(
        `Clicking ${interaction.target} changes nothing. It looks clickable, so it must do something — filter the list below it, open the detail, or stop presenting itself as a target.`,
      );
      continue;
    }
    for (const defect of inspectOverlaySnapshot(interaction)) {
      blocking.push(defect);
    }
  }

  // `desktop`, `desktop-mid` and `desktop-bottom` are ONE layout read at three
  // scroll positions, and both measures here are horizontal: `scrollWidth` and
  // an element's `left`/`right` do not move when the page scrolls down.
  // Measured on a real render, the three rows come back identical — so without
  // this fold a single sideways-scrolling table would spend three of a
  // twelve-slot fix list saying the same thing three times.
  //
  // They are still read at each position rather than once, because content
  // that mounts lazily (a virtualised list) has no width until it is scrolled
  // to. `empty-state` keeps its own name: same width, different state, and an
  // overflow that appears only once the data is gone is its own finding.
  const widest = new Map<string, PageRenderLayout>();
  for (const [label, layout] of Object.entries(render.layout)) {
    const family = label.replace(/-(mid|bottom)$/, "");
    const seen = widest.get(family);
    widest.set(
      family,
      seen === undefined
        ? layout
        : {
            horizontalOverflow:
              seen.horizontalOverflow || layout.horizontalOverflow,
            clipped: Math.max(seen.clipped, layout.clipped),
            textLength: Math.max(seen.textLength, layout.textLength),
          },
    );
  }

  for (const [label, layout] of widest) {
    if (layout.horizontalOverflow) {
      blocking.push(
        `The page scrolls sideways at the ${label} width. Something has a fixed width or a table runs past its container.`,
      );
    }
    if (layout.clipped >= MIN_CLIPPED_ELEMENTS) {
      blocking.push(
        `${layout.clipped.toString()} elements are cut off at the ${label} width — outside the viewport with no way to scroll to them. The layout is ignoring the width instead of adapting to it: stack the columns, or let the region that must stay wide scroll inside itself.`,
      );
    }
  }

  const emptyState = render.layout["empty-state"];
  if (emptyState && emptyState.textLength < MIN_EMPTY_STATE_CHARS) {
    blocking.push(
      "With every dataset returning zero rows the page is blank — no empty state. That is the state it is in on its first day and on any day a filter matches nothing.",
    );
  }
  // The mirror of the rule above, and the sharper one. A page that renders the
  // SAME content with no data as with data is not reading its datasets — the
  // measured shape is a fallback to invented rows, and it ships looking
  // finished: a reviewer sees a populated dashboard in both captures and reads
  // it as working. Observed on a real page that answered an empty connection
  // with a `populateMockData()` array of plausible figures.
  const populated = widest.get("desktop");
  if (
    declaredDatasets > 0 &&
    emptyState !== undefined &&
    populated !== undefined &&
    populated.textLength > MIN_EMPTY_STATE_CHARS &&
    emptyState.textLength >= populated.textLength * EMPTY_STATE_SAME_RATIO
  ) {
    blocking.push(
      "With every dataset returning zero rows the page renders essentially the same content as with data — same figures, same rows. It is not reading its datasets, or it falls back to rows of its own when they come back empty. A page must NEVER show data it invented: drive every figure from the dataset, and say plainly which one is empty.",
    );
  }

  // The drag pass. Two rules block, both proven end to end against real
  // Pragmatic boards in `shared/tests/unit/page-render-drag.test.ts`:
  //
  //  - the teardown collapse — the page HAD draggables, the drag itself
  //    re-rendered something, and every registration died. Nothing else can
  //    produce it: a page with no drag wiring cannot re-render from synthetic
  //    drag events, and a view switch cannot be triggered by them.
  //  - the inert board — draggable elements whose drag no target ever accepts
  //    (a live target calls preventDefault on the cancelable dragover; the
  //    healthy fixture proves the synthetic sequence arms the real library,
  //    so silence here is the page's, not the probe's).
  const drag = render.drag;
  if (drag) {
    if (
      drag.draggablesBeforeDrag > 0 &&
      drag.domChanged &&
      drag.draggablesAfterDrop === 0
    ) {
      blocking.push(
        `${drag.draggablesBeforeDrag.toString()} elements were draggable, the drag re-rendered the page, and now none are — every re-render unregisters them. This is the bind-helper teardown bug: read skills/building-pages/references/libraries/drag-and-drop.md and pass a register CALLBACK, never a value, to the bind helper.`,
      );
    } else if (drag.draggablesBeforeDrag > 0 && !drag.dragoverAccepted) {
      blocking.push(
        `${drag.draggablesBeforeDrag.toString()} elements are draggable but no drop target accepted a simulated drag (dragover never prevented) — the board animates and nothing can ever land. Register a dropTargetForElements on each lane; skills/building-pages/references/libraries/drag-and-drop.md has the shape.`,
      );
    } else if (drag.draggablesBeforeDrag > 0) {
      observations.push(
        `Drag wiring is live: a simulated drag was accepted by a drop target${drag.dropHandled ? " and the drop was handled" : ""}${drag.domChanged ? ", and the DOM updated" : ""}.`,
      );
    }
  }

  const dead = render.interactions.filter(
    (interaction) => !interaction.domChanged && !interaction.overlayOpened,
  ).length;
  if (render.interactions.length > 0 && dead === 0) {
    observations.push(
      `${render.interactions.length.toString()} clickable targets tested, all of them live.`,
    );
  }

  // What the clicks actually asked the bridge to DO.
  //
  // "Live" above only means the DOM moved, and a toast moves the DOM whether or
  // not anything was written — which is how a mail client whose send button
  // resolved a `setTimeout` and toasted "sent" passed three rounds of this.
  // Reported rather than blocked: plenty of good pages are read-only, and the
  // reader (builder or critic) is the one who knows which this is.
  if (render.interactions.length > 0) {
    const calls = render.opsRuns.length;
    observations.push(
      calls === 0
        ? `${render.interactions.length.toString()} targets clicked and NO operation ran — every write on this page is either unwired or faked in local state.`
        : `${calls.toString()} operation ${calls === 1 ? "call" : "calls"} fired by those clicks: ${[...new Set(render.opsRuns)].join(", ")}.`,
    );
  }

  const deduped = [...new Set(blocking)].slice(0, MAX_BLOCKING);
  return { pass: deduped.length === 0, blocking: deduped, observations };
};
