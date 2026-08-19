import { EMPTY_OVERLAY_CHARS } from "@fretik/shared/services/pages/render/probe";
import type { PageRenderResult } from "@fretik/shared/services/pages/render/types";

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

export const gatePageRender = (render: PageRenderResult): PageGateResult => {
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
    }
  }

  for (const [label, layout] of Object.entries(render.layout)) {
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

  const dead = render.interactions.filter(
    (interaction) => !interaction.domChanged && !interaction.overlayOpened,
  ).length;
  if (render.interactions.length > 0 && dead === 0) {
    observations.push(
      `${render.interactions.length.toString()} clickable targets tested, all of them live.`,
    );
  }

  const deduped = [...new Set(blocking)].slice(0, MAX_BLOCKING);
  return { pass: deduped.length === 0, blocking: deduped, observations };
};
