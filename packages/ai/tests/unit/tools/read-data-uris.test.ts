import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import { collapseDataUris } from "../../../src/tools/read";

/**
 * Inlined bytes, folded before `read` counts a line.
 *
 * The shape that produced this: a user attached an HTML mockup whose logo sat
 * in a single `data:image/png;base64,…` line of ~30 000 characters — exactly
 * the byte cap. One `read` returned 246 of 737 lines, all of them inside that
 * one image, and the agent had to be told to page through a file whose
 * structure it had not seen a single tag of.
 */
describe("collapseDataUris", () => {
  const payload = "A".repeat(30_000);

  test("folds a payload to a marker and keeps the markup around it", () => {
    const html = `<img src="data:image/png;base64,${payload}" alt="logo">\n<h1>Cockpit</h1>`;
    const folded = collapseDataUris(html);

    expect(folded.collapsed).toBe(1);
    expect(folded.charsOmitted).toBe(30_000);
    expect(folded.text).toContain("data:image/png;base64,…[30000 chars");
    // What the reader actually came for survives, in place.
    expect(folded.text).toContain('alt="logo"');
    expect(folded.text).toContain("<h1>Cockpit</h1>");
    expect(folded.text.length).toBeLessThan(300);
  });

  test("folds every payload in the file, and counts them", () => {
    const html = [
      `<img src="data:image/png;base64,${payload}">`,
      `<img src="data:image/jpeg;base64,${payload}">`,
    ].join("\n");
    const folded = collapseDataUris(html);
    expect(folded.collapsed).toBe(2);
    expect(folded.charsOmitted).toBe(60_000);
    expect(folded.text).toContain("data:image/jpeg;base64,…");
  });

  test("leaves a short inline payload alone — an icon is part of the markup", () => {
    const html = `<img src="data:image/gif;base64,${"A".repeat(100)}">`;
    expect(collapseDataUris(html)).toEqual({
      text: html,
      collapsed: 0,
      charsOmitted: 0,
    });
  });

  test("a file with no inlined bytes comes back byte for byte", () => {
    const source = '<template>\n  <UButton label="Go" />\n</template>\n';
    const folded = collapseDataUris(source);
    expect(folded.text).toBe(source);
    expect(folded.collapsed).toBe(0);
  });

  test("a data: URI that is not base64 is left alone — it is readable text", () => {
    const svg = `data:image/svg+xml,<svg viewBox="0 0 10 10">${"x".repeat(500)}</svg>`;
    expect(collapseDataUris(svg).collapsed).toBe(0);
  });
});
