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
  opsRuns: [],
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

  test("one sideways-scrolling layout is one finding, not one per scroll position", () => {
    // `desktop`, `desktop-mid` and `desktop-bottom` are the same 1280px layout
    // read three times — measured on a real render, the three rows come back
    // identical, because both measures are horizontal and scrolling down moves
    // neither. Reporting each would spend a quarter of the fix list restating
    // one defect.
    const wide = { horizontalOverflow: true, clipped: 5, textLength: 2_400 };
    const gate = gatePageRender(
      render({
        layout: {
          desktop: wide,
          "desktop-mid": wide,
          "desktop-bottom": wide,
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(
      gate.blocking.filter((line) => line.includes("scrolls sideways")),
    ).toHaveLength(1);
    expect(
      gate.blocking.filter((line) => line.includes("cut off")),
    ).toHaveLength(1);
    expect(gate.blocking.join(" ")).toContain("at the desktop width");
    expect(gate.blocking.join(" ")).not.toContain("desktop-mid");
  });

  test("the emptied page keeps its own name — same width, different state", () => {
    const gate = gatePageRender(
      render({
        layout: {
          desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
          "empty-state": {
            horizontalOverflow: true,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(gate.blocking.join(" ")).toContain("at the empty-state width");
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

/**
 * Inside the overlay — the one region nothing else in this pipeline can see.
 *
 * The captures are taken with every panel dismissed, so a detail slideover is
 * judged by no screenshot and no critic. These are the same raw-value defects
 * the page itself is already held to, run over the panel's structure.
 */
describe("page gate — drag pass", () => {
  const drag = {
    draggablesAtMount: 24,
    draggablesBeforeDrag: 24,
    dragoverAccepted: true,
    dropHandled: true,
    domChanged: true,
    draggablesAfterDrop: 24,
  };

  test("the teardown collapse — draggables die after the drag's own re-render — is blocking", () => {
    const gate = gatePageRender(
      render({ drag: { ...drag, draggablesAfterDrop: 0 } }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("drag-and-drop.md");
  });

  test("no drop target accepting the drag is blocking — the inert board", () => {
    const gate = gatePageRender(
      render({
        drag: {
          ...drag,
          dragoverAccepted: false,
          dropHandled: false,
          domChanged: false,
        },
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("no drop target accepted");
  });

  test("live drag wiring is reported so the reader knows it was exercised", () => {
    const gate = gatePageRender(render({ drag }));
    expect(gate.pass).toBe(true);
    expect(gate.observations.join(" ")).toContain("Drag wiring is live");
  });

  test("a page with nothing draggable says nothing about drag", () => {
    const gate = gatePageRender(render({}));
    expect(gate.observations.join(" ")).not.toContain("drag");
  });
});

describe("page gate — overlay snapshots", () => {
  const opened = (snapshot: string): PageRenderResult =>
    render({
      interactions: [
        interaction({
          overlayOpened: true,
          overlayContentCount: 6,
          overlayTextLength: 220,
          overlaySnapshot: snapshot,
        }),
      ],
    });

  test("catches an object printed as JSON — how Vue actually renders one", () => {
    // Read off a real render, not assumed: `{{ money }}` on a money field puts
    // `{ "amount": 5250, "currencyCode": "EUR" }` on screen. A check written
    // only for "[object Object]" — the shape everyone remembers — would have
    // missed the common case and passed the page.
    const gate = gatePageRender(
      opened(
        'h2 Deal detail\n  dt Budget\n  dd { "amount": 5250, "currencyCode": "EUR" }',
      ),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("prints an object");
  });

  test("catches the other shape too", () => {
    expect(
      gatePageRender(opened("h2 Deal detail\n  dd [object Object]")).pass,
    ).toBe(false);
  });

  test("catches a machine timestamp shown to a person", () => {
    const gate = gatePageRender(
      opened("h2 Deal detail\n  dt Created\n  dd 2026-08-20T14:31:00Z"),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("raw ISO timestamp");
  });

  test("does NOT flag a calendar date the page formatted itself", () => {
    // `date` fields arrive as "2026-09-21" and rendering one is correct. A rule
    // that fired on any dash-separated date would fail working pages, which is
    // a worse outcome than missing a defect.
    expect(
      gatePageRender(opened("h2 Deal\n  dt Due\n  dd 2026-09-21")).pass,
    ).toBe(true);
  });

  test("catches a record id printed where a name belongs", () => {
    const gate = gatePageRender(
      opened("h2 Owner\n  p 01a00f76-e653-7033-8292-fd2099ddad0b"),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("raw uuid");
  });

  test("a well-built panel passes", () => {
    expect(
      gatePageRender(
        opened(
          [
            "h2 GEODIS France",
            "  dt Budget",
            "  dd 5 250,00 €",
            "  dt Owner",
            "  dd Dara Nilsson",
            "  button Mark won",
          ].join("\n"),
        ),
      ).pass,
    ).toBe(true);
  });

  test("an overlay the probe never serialised is not judged", () => {
    // Only the first few overlays of a pass carry a snapshot. Absence is a
    // budget, never evidence of a clean panel.
    expect(
      gatePageRender(
        render({
          interactions: [
            interaction({ overlayOpened: true, overlayContentCount: 6 }),
          ],
        }),
      ).pass,
    ).toBe(true);
  });
});

/**
 * A click that changes the DOM proves the control is alive, never that it
 * wrote anything — the harness answers every `ops.run` without executing it,
 * and a success toast is a mutation whether or not one was made. The measured
 * case: a mail client whose send button resolved a `setTimeout` and toasted
 * "sent" cleared three rounds of this gate.
 */
describe("page gate — operation traffic", () => {
  test("clicks that ran nothing are called out", () => {
    const gate = gatePageRender(
      render({
        interactions: [interaction({ target: 'button "Envoyer"' })],
        opsRuns: [],
      }),
      { declaredOperations: 1 },
    );
    expect(gate.pass).toBe(true);
    expect(gate.observations.join(" ")).toContain("NO operation ran");
  });

  test("the operations that did run are named", () => {
    const gate = gatePageRender(
      render({
        interactions: [interaction({ target: 'button "Envoyer"' })],
        opsRuns: ["send_mail", "send_mail", "mark_read"],
      }),
      { declaredOperations: 2 },
    );
    const observed = gate.observations.join(" ");
    expect(observed).toContain("3 operation calls");
    expect(observed).toContain("send_mail, mark_read");
  });

  test("a page nobody clicked says nothing either way", () => {
    const gate = gatePageRender(render({ interactions: [], opsRuns: [] }), {
      declaredOperations: 1,
    });
    expect(gate.observations.join(" ")).not.toContain("operation");
  });

  /**
   * A read-only dashboard declares no operation, so none running is the
   * correct outcome. Two production builds were told every write on the page
   * was "unwired or faked" — on pages that had no write to wire — and spent
   * review rounds looking for it.
   */
  test("a page that declares no operation is not accused of faking one", () => {
    const gate = gatePageRender(
      render({
        interactions: [interaction({ target: 'button "Filtrer"' })],
        opsRuns: [],
      }),
      { declaredDatasets: 2, declaredOperations: 0 },
    );
    expect(gate.observations.join(" ")).not.toContain("NO operation ran");
  });
});

/**
 * The probe leaves the already-selected tab alone — clicking it changes
 * nothing by design. Saying so is what keeps a reader from assuming every
 * control was measured.
 */
describe("page gate — controls left alone", () => {
  test("controls already in their target state are reported, not counted as dead", () => {
    const gate = gatePageRender(
      render({
        interactions: [interaction({ target: 'button "Lanes"' })],
        skippedActive: 3,
      }),
    );
    expect(gate.pass).toBe(true);
    expect(gate.observations.join(" ")).toContain("3 controls were left");
  });

  test("a page with nothing skipped says nothing about it", () => {
    const gate = gatePageRender(
      render({ interactions: [interaction({ target: 'button "Lanes"' })] }),
    );
    expect(gate.observations.join(" ")).not.toContain("left unclicked");
  });
});

/**
 * A page's own views.
 *
 * Nothing upstream can catch a view that mounts and paints nothing: the
 * compiler links the module, the lints see a template, and the first screen —
 * the only one anyone used to look at — is fine.
 */
describe("page gate — the page's other views", () => {
  test("a view that renders nothing is blocking, and the message names it", () => {
    const gate = gatePageRender(
      render({
        routes: ["/", "/deal/:id"],
        layout: {
          desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
          "route:/deal/1": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 4,
          },
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("/deal/1");
    expect(gate.blocking.join(" ")).toContain("renders nothing");
  });

  test("a view with content passes, and the captures are reported", () => {
    const gate = gatePageRender(
      render({
        routes: ["/", "/settings"],
        layout: {
          desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
          "route:/settings": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 900,
          },
          "empty-state": {
            horizontalOverflow: false,
            clipped: 0,
            textLength: 420,
          },
        },
      }),
    );
    expect(gate.pass).toBe(true);
    expect(gate.observations.join(" ")).toContain("/settings");
  });

  test("a route the router could not match blocks, however the page reached it", () => {
    const gate = gatePageRender(
      render({
        routes: ["/", "/deal/:id"],
        routeMisses: [
          'No view matches "/archive" — add the file for it under pages/.',
        ],
      }),
    );
    expect(gate.pass).toBe(false);
    expect(gate.blocking.join(" ")).toContain("/archive");
  });

  test("a page with no views of its own is never asked about them", () => {
    const gate = gatePageRender(
      render({ interactions: [interaction({ target: 'button "Lanes"' })] }),
    );
    expect(gate.observations.join(" ")).not.toContain(
      "of the page's own views",
    );
  });
});
