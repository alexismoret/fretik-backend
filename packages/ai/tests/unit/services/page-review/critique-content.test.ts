import type {
  PageRenderInteraction,
  PageRenderShot,
} from "@fretik/shared/services/pages/render/types";
import { describe, expect, test } from "bun:test";
import { buildCritiqueContent } from "../../../../src/services/page-review/evaluate";

/**
 * What the critic is actually SHOWN.
 *
 * The captures are taken with every panel dismissed, so a detail slideover or a
 * compose modal — the part of a page a team spends its time in — reaches the
 * critic through this text block or through nothing at all. That made it the
 * one part of the review with no test: the gate's snapshot checks were pinned,
 * the critic's copy of the same snapshot was not.
 */

const shot = (label: string): PageRenderShot => ({
  label,
  width: 1440,
  height: 900,
  png: new Uint8Array([1, 2, 3]),
});

const interaction = (
  over: Partial<PageRenderInteraction>,
): PageRenderInteraction => ({
  target: 'row "Eval Item 01"',
  kind: "row",
  domChanged: true,
  overlayOpened: true,
  overlayTextLength: 200,
  overlayContentCount: 6,
  ...over,
});

const textOf = async (
  over: Partial<Parameters<typeof buildCritiqueContent>[0]> = {},
): Promise<string[]> => {
  const [message] = await buildCritiqueContent({
    pageName: "Eval Work Items",
    brief: undefined,
    shots: [shot("desktop")],
    known: [],
    ...over,
  });
  if (!message || typeof message.content === "string") return [];
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
};

describe("the overlays the click pass opened", () => {
  test("a snapshot reaches the critic verbatim", async () => {
    const parts = await textOf({
      interactions: [
        interaction({ overlaySnapshot: "dialog\n  heading Eval Item 01" }),
      ],
    });
    const block = parts.find((text) =>
      text.startsWith("## overlays opened during the click pass"),
    );
    expect(block).toBeDefined();
    expect(block).toContain("heading Eval Item 01");
    expect(block).toContain('row "Eval Item 01"');
  });

  test("it sits ABOVE the captures, because it says it does", async () => {
    // "These panels are NOT in the captures below" is only true in that order.
    const parts = await textOf({
      interactions: [interaction({ overlaySnapshot: "dialog" })],
      shots: [shot("desktop"), shot("mobile")],
    });
    const overlays = parts.findIndex((text) =>
      text.startsWith("## overlays opened"),
    );
    const captures = parts.findIndex((text) => text === "## captures");
    expect(overlays).toBeGreaterThanOrEqual(0);
    expect(captures).toBeGreaterThan(overlays);
  });

  test("a click that opened nothing adds no block at all", async () => {
    // An empty section reads as "there are no overlays on this page", which is
    // a claim about the page rather than about the pass.
    const parts = await textOf({
      interactions: [interaction({ overlayOpened: false })],
    });
    expect(parts.some((text) => text.startsWith("## overlays opened"))).toBe(
      false,
    );
  });

  test("every opened overlay is carried, not just the first", async () => {
    const parts = await textOf({
      interactions: [
        interaction({ overlaySnapshot: "dialog A" }),
        interaction({ target: 'button "New"', overlaySnapshot: "dialog B" }),
      ],
    });
    const block = parts.find((text) => text.startsWith("## overlays opened"));
    expect(block).toContain("dialog A");
    expect(block).toContain("dialog B");
  });
});
