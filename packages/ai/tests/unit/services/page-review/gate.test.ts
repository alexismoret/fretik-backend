import type {
  PageRenderInteraction,
  PageRenderResult,
} from "@fretik/shared/services/pages/render/types";
import { describe, expect, test } from "bun:test";
import { gatePageRender } from "../../../../src/services/page-review/gate";

/**
 * The gate is the half of a review no model can talk its way past, so what it
 * must catch is fixed here by the defects that actually shipped in v3.
 */

const interaction = (
  over: Partial<PageRenderInteraction>,
): PageRenderInteraction => ({
  target: 'row "GEODIS France"',
  kind: "row",
  domChanged: true,
  overlayOpened: false,
  overlayTextLength: 0,
  overlayContentCount: 0,
  ...over,
});

const render = (over: Partial<PageRenderResult>): PageRenderResult => ({
  mounted: true,
  settled: true,
  shots: [],
  interactions: [],
  layout: {
    desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
    mobile: { horizontalOverflow: false, clipped: 0, textLength: 2_100 },
    "empty-state": { horizontalOverflow: false, clipped: 0, textLength: 420 },
  },
  consoleErrors: [],
  pageErrors: [],
  ...over,
});

describe("page gate", () => {
  test("a page that renders, clicks through and empties cleanly passes", () => {
    const gate = gatePageRender(
      render({
        interactions: [
          interaction({ overlayOpened: true, overlayContentCount: 9 }),
          interaction({ target: 'button "Tous les statuts"', kind: "button" }),
        ],
      }),
    );
    expect(gate.pass).toBe(true);
    expect(gate.blocking).toEqual([]);
    expect(gate.observations.join(" ")).toContain("all of them live");
  });

  test("an overlay that opens empty is blocking, and the message names both causes", () => {
    // The real defect, twice over: a slideover wired to `@select="open"` never
    // receives the row, and a form written into a modal's default slot renders
    // as the trigger instead of the panel.
    const gate = gatePageRender(
      render({
        interactions: [
          interaction({
            overlayOpened: true,
            overlayTextLength: 34,
            overlayContentCount: 0,
          }),
        ],
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking).toHaveLength(1);
    expect(gate.blocking[0]).toContain('row "GEODIS France"');
    expect(gate.blocking[0]).toContain("(e, row)");
    expect(gate.blocking[0]).toContain("#body");
  });

  test("an overlay carrying only placeholder inputs is NOT empty", () => {
    // A form of empty fields contributes almost nothing to `innerText`;
    // counting characters alone would condemn a perfectly good panel.
    const gate = gatePageRender(
      render({
        interactions: [
          interaction({
            overlayOpened: true,
            overlayTextLength: 12,
            overlayContentCount: 5,
          }),
        ],
      }),
    );
    expect(gate.pass).toBe(true);
  });

  test("a target that looks clickable and changes nothing is blocking", () => {
    const gate = gatePageRender(
      render({
        interactions: [
          interaction({
            target: 'chip "Transport" in "Prospects par secteur"',
            kind: "pointer",
            domChanged: false,
          }),
        ],
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking[0]).toContain("changes nothing");
  });

  test("sideways scroll is named with the width it happens at", () => {
    const gate = gatePageRender(
      render({
        layout: {
          desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
          mobile: { horizontalOverflow: true, clipped: 0, textLength: 2_100 },
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(gate.blocking.join(" ")).toContain("at the mobile width");
  });

  test("a layout clipped at a narrow width is blocking even when nothing scrolls", () => {
    // The failure `scrollWidth > clientWidth` cannot see: a shell that clips
    // rather than scrolls reports no overflow while half the page is cut off.
    const gate = gatePageRender(
      render({
        layout: {
          desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
          mobile: { horizontalOverflow: false, clipped: 7, textLength: 285 },
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("cut off at the mobile width");
  });

  test("one element past the edge is measurement noise, not a finding", () => {
    const gate = gatePageRender(
      render({
        layout: {
          desktop: { horizontalOverflow: false, clipped: 1, textLength: 2_400 },
          mobile: { horizontalOverflow: false, clipped: 0, textLength: 2_100 },
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(gate.pass).toBe(true);
  });

  test("a page that goes blank once the data is empty is blocking", () => {
    const gate = gatePageRender(
      render({
        layout: {
          desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
          mobile: { horizontalOverflow: false, clipped: 0, textLength: 2_100 },
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 8,
          },
        },
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("no empty state");
  });

  test("a page that never mounted says so first, before anything else", () => {
    const gate = gatePageRender(
      render({
        mounted: false,
        pageErrors: ["TypeError: x is not a function"],
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking[0]).toContain("never mounted");
    expect(gate.blocking.join(" ")).toContain("TypeError");
  });

  test("the same console error repeated is one finding, not thirty", () => {
    const gate = gatePageRender(
      render({ consoleErrors: Array.from({ length: 30 }, () => "same boom") }),
    );
    expect(gate.blocking).toHaveLength(1);
  });
});
